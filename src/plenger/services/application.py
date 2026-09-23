"""Shared application services: no target execution and no hosted calls."""

import base64
import binascii
import hashlib
import hmac
import html
import json
import uuid
from pathlib import Path
from typing import Any, cast

from sqlalchemy import text
from sqlalchemy.engine import Engine

from plenger.adapters import IMAGE, SandboxError, cleanup_run, execute, probe
from plenger.adapters.promptfoo import capability as promptfoo_capability
from plenger.broker.ipc import active_runner_capability
from plenger.domain import RunState
from plenger.policy import redact
from plenger.services.integrity import check_report
from plenger.services.scanners import (
    run_managed_scanners,
    scanner_capabilities,
    scanner_findings_to_report,
    scanner_manifest_digest,
)
from plenger.services.snapshot import manifest
from plenger.services.workspace import capture, load_config
from plenger.storage import latest_report_id, open_store, reports
from plenger.storage.assessments import list_assessments
from plenger.storage.attempts import mark_interrupted_active_attempts
from plenger.storage.findings import (
    active_suppression,
    default_retention_until,
    evidence_digest,
    expired_evidence_ids,
    latest_suppression,
    normalized_findings,
    persist_report_entities,
    purge_expired_evidence,
    serialize_normalized_finding,
    update_lifecycle,
)
from plenger.storage.graph import graph_page as normalized_graph_page
from plenger.storage.graph import persist_graph_entities
from plenger.storage.locking import StoreBusy, runtime_lock
from plenger.storage.runs import (
    RunConflict,
    advance,
    annotate_cleanup,
    claim_lease,
    create_run,
    digest,
    get_run,
    list_runs,
    list_runs_page,
    now,
    project_key,
    recover,
    release_lease,
)


def project_id(root: Path) -> str:
    return hashlib.sha256(str(root.resolve()).encode()).hexdigest()


_FINDING_CURSOR_VERSION = 2
_FINDING_CURSOR_SIGNATURE_SIZE = hashlib.sha256().digest_size
_FINDING_CURSOR_MAX_LENGTH = 8192
_FINDING_FILTER_NAMES = {
    "severity",
    "validation_state",
    "lifecycle_state",
    "kind",
    "source_path",
}


def _normalize_finding_filters(filters: dict[str, str] | None) -> dict[str, str]:
    requested = filters or {}
    if any(
        name not in _FINDING_FILTER_NAMES
        or not isinstance(value, str)
        or not value
        or len(value) > 256
        for name, value in requested.items()
    ):
        raise ValueError("invalid_finding_filter")
    allowed_values = {
        "severity": {"info", "low", "medium", "high", "critical", "unknown"},
        "validation_state": {"candidate", "supported", "confirmed", "disputed"},
        "lifecycle_state": {"open", "acknowledged", "suppressed", "resolved"},
    }
    for name, values in allowed_values.items():
        value = requested.get(name)
        if value is not None and value not in values:
            raise ValueError("invalid_finding_filter")
    return {name: requested[name] for name in sorted(requested)}


def _encode_finding_cursor(
    key: bytes, item: dict[str, Any], run_id: str, filters: dict[str, str]
) -> str:
    source_ref = item.get("source_ref")
    finding_id = item.get("id")
    if not isinstance(source_ref, dict) or not isinstance(finding_id, str):
        raise ValueError("invalid_finding_cursor")
    path = source_ref.get("path")
    line = source_ref.get("line")
    if (
        not isinstance(path, str)
        or not path
        or len(path) > 4096
        or not isinstance(line, int)
        or isinstance(line, bool)
        or line < 1
        or not finding_id
        or len(finding_id) > 256
    ):
        raise ValueError("invalid_finding_cursor")
    payload = json.dumps(
        {
            "v": _FINDING_CURSOR_VERSION,
            "run_id": run_id,
            "filters": filters,
            "path": path,
            "line": line,
            "id": finding_id,
        },
        separators=(",", ":"),
        sort_keys=True,
    ).encode()
    signature = hmac.new(key, payload, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(payload + b"." + signature).decode("ascii").rstrip("=")


def _decode_finding_cursor(key: bytes, token: str) -> tuple[str, int, str, str, dict[str, str]]:
    if not isinstance(token, str) or not 1 <= len(token) <= _FINDING_CURSOR_MAX_LENGTH:
        raise ValueError("invalid_finding_cursor")
    try:
        raw = base64.b64decode(
            token + "=" * ((4 - len(token) % 4) % 4), altchars=b"-_", validate=True
        )
    except (ValueError, binascii.Error, UnicodeEncodeError):
        raise ValueError("invalid_finding_cursor") from None
    # Reject alternate/non-canonical encodings.  Without this check, changing
    # unused padding bits in the final Base64URL character can decode to the
    # same signed bytes and bypass the tamper check at the token layer.
    if base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=") != token:
        raise ValueError("invalid_finding_cursor")
    if len(raw) <= _FINDING_CURSOR_SIGNATURE_SIZE + 1:
        raise ValueError("invalid_finding_cursor")
    separator = len(raw) - _FINDING_CURSOR_SIGNATURE_SIZE - 1
    if raw[separator : separator + 1] != b".":
        raise ValueError("invalid_finding_cursor")
    payload = raw[:separator]
    signature = raw[separator + 1 :]
    expected = hmac.new(key, payload, hashlib.sha256).digest()
    if not hmac.compare_digest(signature, expected):
        raise ValueError("invalid_finding_cursor")
    try:
        value = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ValueError("invalid_finding_cursor") from None
    if not isinstance(value, dict) or value.get("v") != _FINDING_CURSOR_VERSION:
        raise ValueError("invalid_finding_cursor")
    run_id = value.get("run_id")
    raw_filters = value.get("filters")
    path = value.get("path")
    line = value.get("line")
    finding_id = value.get("id")
    if (
        not isinstance(run_id, str)
        or not run_id
        or len(run_id) > 128
        or not isinstance(raw_filters, dict)
        or not isinstance(path, str)
        or not path
        or len(path) > 4096
        or not isinstance(line, int)
        or isinstance(line, bool)
        or line < 1
        or not isinstance(finding_id, str)
        or not finding_id
        or len(finding_id) > 256
    ):
        raise ValueError("invalid_finding_cursor")
    try:
        filters = _normalize_finding_filters(raw_filters)
    except ValueError:
        raise ValueError("invalid_finding_cursor") from None
    return path, line, finding_id, run_id, filters


def _scope_report_entity_ids(report: dict[str, Any], run_id: str) -> None:
    """Keep normalized primary keys unique while fingerprints remain cross-run stable."""

    for finding in report.get("findings", []):
        if not isinstance(finding, dict):
            continue
        finding_id = finding.get("id")
        if isinstance(finding_id, str):
            finding["id"] = digest([run_id, "finding", finding_id])
        evidence_items = [finding.get("evidence")]
        extra_evidence = finding.get("evidence_refs")
        if isinstance(extra_evidence, list):
            evidence_items.extend(extra_evidence)
        for evidence in evidence_items:
            if not isinstance(evidence, dict):
                continue
            evidence_id = evidence.get("id")
            if isinstance(evidence_id, str):
                evidence["id"] = digest([run_id, "evidence", evidence_id])


def capabilities(root: Path | None = None) -> dict[str, Any]:
    return {
        "deterministic": probe(),
        **scanner_capabilities(root),
        "promptfoo": promptfoo_capability(),
        "jev": {"status": "unavailable", "reason": "not_live_verified"},
        "active_runner": active_runner_capability(),
    }


def _scan_config_hash(root: Path, config: Any) -> str:
    return digest(
        {
            "project": config.model_dump(),
            "scanner_manifest": scanner_manifest_digest(root),
        }
    )


def queue_scan(root: Path, profile: str, fixture: bool, request_key: str) -> tuple[str, bool]:
    config = load_config(root)
    if profile not in {"deterministic", "baseline"}:
        raise ValueError("unsupported_profile")
    if not request_key or len(request_key) > 128:
        raise ValueError("invalid_idempotency_key")
    engine = open_store(root)
    try:
        return create_run(
            engine, project_id(root), profile, fixture, _scan_config_hash(root, config), request_key
        )
    finally:
        engine.dispose()


def run_status(root: Path, run_id: str) -> dict[str, Any] | None:
    engine = open_store(root)
    try:
        return get_run(engine, project_id(root), run_id)
    finally:
        engine.dispose()


def run_history(root: Path, limit: int = 50, offset: int = 0) -> list[dict[str, Any]]:
    """Return bounded run metadata for the local project dashboard."""

    load_config(root)
    engine = open_store(root)
    try:
        return list_runs(engine, project_id(root), limit, offset)
    finally:
        engine.dispose()


def run_history_page(
    root: Path, limit: int = 50, offset: int = 0
) -> tuple[list[dict[str, Any]], bool]:
    """Return bounded run metadata and a truthful continuation flag."""

    load_config(root)
    engine = open_store(root)
    try:
        return list_runs_page(engine, project_id(root), limit, offset)
    finally:
        engine.dispose()


def recover_workers(engine: Engine, identity: str, include_queued: bool = False) -> int:
    with engine.connect() as connection:
        orphan_ids = (
            connection.execute(
                text(
                    "SELECT id FROM runs WHERE project_id=:p "
                    "AND (state IN ('running','cancelling') OR reason='orphan_cleanup_pending')"
                ),
                {"p": identity},
            )
            .scalars()
            .all()
        )
    cleanup_pending = any(not cleanup_run(run_id) for run_id in orphan_ids)
    if not cleanup_pending:
        with engine.begin() as connection:
            for run_id in orphan_ids:
                annotate_cleanup(connection, identity, run_id)
    recovered = recover(engine, identity, include_queued, cleanup_pending)
    if orphan_ids:
        mark_interrupted_active_attempts(engine, identity, [str(item) for item in orphan_ids])
    return recovered


def recover_runs(root: Path) -> int:
    engine = open_store(root)
    try:
        with runtime_lock(root):
            return recover_workers(engine, project_id(root), include_queued=True)
    except StoreBusy:
        return 0  # A live process owns the worker. Do not interrupt its ledger.
    finally:
        engine.dispose()


def execute_scan(root: Path, run_id: str) -> dict[str, Any]:
    engine = open_store(root)
    identity = project_id(root)
    lease_owner = "static-" + run_id
    lease_claimed = False
    try:
        with runtime_lock(root):
            recover_workers(engine, identity)
            run = get_run(engine, identity, run_id)
            if run is None or run["state"] != "queued":
                raise RunConflict("run_not_queued")
            with engine.connect() as connection:
                pending = connection.execute(
                    text(
                        "SELECT COUNT(*) FROM runs "
                        "WHERE project_id=:p AND reason='orphan_cleanup_pending'"
                    ),
                    {"p": identity},
                ).scalar_one()
            if pending:
                with engine.begin() as connection:
                    advance(
                        connection,
                        identity,
                        run_id,
                        RunState.BLOCKED,
                        "prior_orphan_cleanup_pending",
                    )
                raise SandboxError("orphan_cleanup_pending")
            try:
                config = load_config(root)
                if _scan_config_hash(root, config) != run["config_hash"]:
                    with engine.begin() as connection:
                        advance(connection, identity, run_id, RunState.BLOCKED, "config_changed")
                    raise RunConflict("config_changed")
                with engine.begin() as connection:
                    claim_lease(connection, identity, run_id, lease_owner, ttl_seconds=60)
                    lease_claimed = True
                    advance(connection, identity, run_id, RunState.RUNNING)
                if probe()["status"] != "ready":
                    raise SandboxError("sandbox_unavailable")
                files, skipped = capture(root, config, include_scanner_inputs=True)
                python_files = {
                    path: source for path, source in files.items() if path.endswith(".py")
                }
                snapshot = manifest(
                    files, skipped, project_key(engine, identity), identity, root=root
                )
                result = execute(python_files, identity, run_id)
                scanner_results: list[dict[str, Any]] = []
                scanner_errors: list[dict[str, str]] = []
                scanner_states: dict[str, dict[str, str]] = {}
                scanner_findings: list[dict[str, Any]] = []
                if run["profile"] == "baseline":
                    normalized_results, scanner_states = run_managed_scanners(root, files)
                    scanner_results = [item.model_dump() for item in normalized_results]
                    scanner_findings = scanner_findings_to_report(normalized_results)
                    scanner_errors = [
                        {"engine": engine_name, "reason": state.get("reason", "unknown")}
                        for engine_name, state in scanner_states.items()
                        if state.get("status") != "completed"
                    ]
                    result["findings"].extend(scanner_findings)
                    result["scanner_results"] = scanner_results
                    result["scanner_errors"] = scanner_errors
                worker = Path(__file__).resolve().parents[1] / "graph/worker.py"
                engine_states = capabilities(root)
                engine_states.update(scanner_states)
                report: dict[str, Any] = redact(
                    {
                        "schema_version": 1,
                        "fixture": bool(run["fixture"]),
                        "run_id": run_id,
                        "snapshot_id": snapshot["id"],
                        "snapshot": snapshot,
                        "project_id": identity,
                        "created_at": now(),
                        "profile": run["profile"],
                        "state": "completed_with_errors"
                        if result["errors"] or scanner_errors
                        else "completed",
                        "manifest": {
                            "parser": "python-ast-v2",
                            "image": IMAGE,
                            "worker_sha256": hashlib.sha256(worker.read_bytes()).hexdigest(),
                        },
                        "coverage": [
                            {"category": f"LLM{i:02d}", "state": "not_tested"} for i in range(1, 11)
                        ],
                        "engine_states": engine_states,
                        "assessments": [],
                        "skipped": skipped,
                        "notice": (
                            "Analisis terbatas; candidate memerlukan review. Bukan sertifikasi."
                        ),
                        **result,
                    }
                )
                _scope_report_entity_ids(report, run_id)
                for finding in report["findings"]:
                    finding["snapshot_id"] = snapshot["id"]
                    evidence_items = [finding.get("evidence")]
                    extra_evidence = finding.get("evidence_refs")
                    if isinstance(extra_evidence, list):
                        evidence_items.extend(extra_evidence)
                    for evidence in evidence_items:
                        if not isinstance(evidence, dict):
                            continue
                        evidence["run_id"] = run_id
                        evidence["retention_until"] = (
                            evidence.get("retention_until") or default_retention_until()
                        )
                        evidence["sha256_redacted"] = evidence_digest(evidence)
                # Keep the final persistence and return boundaries defensive even if a
                # later enrichment hook mutates the already-redacted structures.
                safe_snapshot = cast(dict[str, Any], redact(snapshot))
                safe_report = cast(dict[str, Any], redact(report))
                # Report, snapshot and final state commit together or not at all.
                with engine.begin() as connection:
                    connection.execute(
                        text(
                            "INSERT INTO snapshots "
                            "(id,run_id,project_id,manifest_digest,payload) "
                            "VALUES (:id,:r,:p,:d,:v)"
                        ),
                        {
                            "id": safe_snapshot["id"],
                            "r": run_id,
                            "p": identity,
                            "d": safe_snapshot["manifest_digest"],
                            "v": json.dumps(safe_snapshot),
                        },
                    )
                    connection.execute(
                        text("INSERT INTO reports (id,project_id,payload) VALUES (:id,:p,:v)"),
                        {"id": run_id, "p": identity, "v": json.dumps(safe_report)},
                    )
                    persist_report_entities(connection, safe_report)
                    persist_graph_entities(connection, safe_report)
                    advance(connection, identity, run_id, RunState(safe_report["state"]))
                return safe_report
            except (Exception, KeyboardInterrupt) as exc:
                current = get_run(engine, identity, run_id)
                if current and current["state"] in {"queued", "running"}:
                    if isinstance(exc, KeyboardInterrupt):
                        state, reason = RunState.INTERRUPTED, "interrupted"
                    elif current["state"] == "queued":
                        state, reason = RunState.BLOCKED, "invalid_config"
                    else:
                        state = RunState.FAILED
                        reason = (
                            "sandbox_unavailable"
                            if isinstance(exc, SandboxError)
                            else "scan_failed"
                        )
                    with engine.begin() as connection:
                        advance(connection, identity, run_id, state, reason)
                raise
    except StoreBusy:
        with engine.begin() as connection:
            advance(connection, identity, run_id, RunState.BLOCKED, "project_worker_busy")
        raise
    finally:
        if lease_claimed:
            with engine.begin() as connection:
                release_lease(connection, identity, run_id, lease_owner)
        engine.dispose()


def scan(root: Path, profile: str, fixture: bool = False) -> dict[str, Any]:
    run_id, _ = queue_scan(root, profile, fixture, uuid.uuid4().hex)
    return execute_scan(root, run_id)


def ci_exit_code(report: dict[str, Any], fail_on: str | None = None) -> int:
    """Map a report to CI semantics without treating candidates as confirmed."""

    state = report.get("state")
    if state in {"cancelled", "interrupted"}:
        return 130
    if state == "blocked":
        return 3
    if state != "completed":
        return 2
    if report.get("errors") or report.get("scanner_errors"):
        return 2
    if fail_on is None:
        return 0
    levels = {"info": 0, "low": 1, "medium": 2, "high": 3, "critical": 4}
    threshold = levels.get(fail_on.lower())
    if threshold is None:
        raise ValueError("invalid_fail_on_severity")
    for finding in report.get("findings", []):
        if finding.get("validation_state") not in {"supported", "confirmed"}:
            continue
        if levels.get(str(finding.get("severity", "")).lower(), -1) >= threshold:
            return 1
    return 0


def latest(root: Path, run_id: str | None = None) -> dict[str, Any] | None:
    load_config(root)
    engine = open_store(root)
    try:
        purge_expired_evidence(engine, project_id(root))
        expired = expired_evidence_ids(engine, project_id(root))
        _purge_report_mirrors(engine, project_id(root), expired)
        result = reports(engine, project_id(root), run_id)
        clean: dict[str, Any] | None = check_report(redact(result)) if result else None
        if clean:
            _expire_report_evidence(clean, expired)
            for finding in clean.get("findings", []):
                fingerprint = finding.get("fingerprint")
                if not isinstance(fingerprint, str):
                    continue
                suppression = active_suppression(engine, project_id(root), fingerprint)
                if suppression:
                    finding["suppression"] = {
                        "actor": suppression["actor"],
                        "reason": suppression["reason"],
                        "expires_at": suppression["expires_at"],
                    }
                elif finding.get("lifecycle_state") == "suppressed":
                    historical = latest_suppression(engine, project_id(root), fingerprint)
                    finding["lifecycle_state"] = "open"
                    finding["suppression_state"] = "expired" if historical else "not_found"
        return clean
    finally:
        engine.dispose()


def findings_page_with_cursor(
    root: Path,
    limit: int = 100,
    offset: int = 0,
    cursor: str | None = None,
    filters: dict[str, str] | None = None,
    requested_run_id: str | None = None,
) -> tuple[list[dict[str, Any]], str | None]:
    """Read normalized findings and return an opaque keyset cursor for the next page."""

    if not 1 <= limit <= 100 or offset < 0 or (cursor is not None and offset != 0):
        raise ValueError("invalid_finding_pagination")
    normalized_filters = _normalize_finding_filters(filters)
    if requested_run_id is not None and (not requested_run_id or len(requested_run_id) > 128):
        raise ValueError("invalid_run_id")
    load_config(root)
    identity = project_id(root)
    engine = open_store(root)
    try:
        purge_expired_evidence(engine, identity)
        key = project_key(engine, identity)
        run_id = requested_run_id or latest_report_id(engine, identity)
        if run_id is None:
            return [], None
        if requested_run_id is not None:
            with engine.connect() as connection:
                report_exists = connection.execute(
                    text("SELECT 1 FROM reports WHERE id=:run AND project_id=:project"),
                    {"run": requested_run_id, "project": identity},
                ).first()
            if report_exists is None:
                return [], None
        after = None
        if cursor is not None:
            cursor_path, cursor_line, cursor_id, cursor_run_id, cursor_filters = (
                _decode_finding_cursor(key, cursor)
            )
            if cursor_run_id != run_id or cursor_filters != normalized_filters:
                raise ValueError("invalid_finding_cursor")
            after = (cursor_path, cursor_line, cursor_id)
        rows = normalized_findings(
            engine,
            identity,
            run_id,
            limit,
            offset,
            after=after,
            fetch_extra=True,
            filters=normalized_filters,
        )
        output: list[dict[str, Any]] = []
        for row in rows:
            item = serialize_normalized_finding(row)
            evidence_items = [item.get("evidence")]
            extra_evidence = item.get("evidence_refs")
            if isinstance(extra_evidence, list):
                evidence_items.extend(extra_evidence)
            if any(
                isinstance(evidence, dict) and evidence.get("observed") == "[EXPIRED]"
                for evidence in evidence_items
            ):
                item["evidence_expired"] = True
                item["evidence_integrity"] = "expired"
            fingerprint = item.get("fingerprint")
            if isinstance(fingerprint, str):
                suppression = active_suppression(engine, identity, fingerprint)
                if suppression:
                    item["suppression"] = {
                        "actor": suppression["actor"],
                        "reason": suppression["reason"],
                        "expires_at": suppression["expires_at"],
                    }
                elif item.get("lifecycle_state") == "suppressed":
                    historical = latest_suppression(engine, identity, fingerprint)
                    item["lifecycle_state"] = "open"
                    item["suppression_state"] = "expired" if historical else "not_found"
            output.append(item)
        has_more = len(output) > limit
        page = output[:limit]
        next_cursor = (
            _encode_finding_cursor(key, page[-1], run_id, normalized_filters)
            if has_more and page
            else None
        )
        return page, next_cursor
    finally:
        engine.dispose()


def findings_page(root: Path, limit: int = 100, offset: int = 0) -> list[dict[str, Any]]:
    """Read one public findings page from normalized storage, not the report mirror."""

    page, _ = findings_page_with_cursor(root, limit, offset)
    return page


def graph_page(
    root: Path,
    limit: int = 100,
    offset: int = 0,
    requested_run_id: str | None = None,
    node_kind: str | None = None,
    source_path: str | None = None,
) -> dict[str, Any]:
    """Read one graph page from normalized storage, not the report mirror."""

    if requested_run_id is not None and (not requested_run_id or len(requested_run_id) > 128):
        raise ValueError("invalid_run_id")
    load_config(root)
    identity = project_id(root)
    engine = open_store(root)
    try:
        run_id = requested_run_id or latest_report_id(engine, identity)
        if run_id is None:
            return {"snapshot_id": None, "nodes": [], "edges": [], "next_offset": None}
        return normalized_graph_page(
            engine, identity, run_id, limit, offset, node_kind, source_path
        )
    finally:
        engine.dispose()


def _expire_report_evidence(report: dict[str, Any], expired: set[str]) -> None:
    for finding in report.get("findings", []):
        evidence_items = [finding.get("evidence")]
        extra_evidence = finding.get("evidence_refs")
        if isinstance(extra_evidence, list):
            evidence_items.extend(extra_evidence)
        for evidence in evidence_items:
            if isinstance(evidence, dict) and evidence.get("id") in expired:
                evidence["observed"] = "[EXPIRED]"
                evidence["size"] = 0
                finding["evidence_expired"] = True
                finding["evidence_integrity"] = "expired"


def _purge_report_mirrors(engine: Engine, identity: str, expired: set[str]) -> None:
    if not expired:
        return
    with engine.begin() as connection:
        rows = connection.execute(
            text("SELECT id,payload FROM reports WHERE project_id=:project"),
            {"project": identity},
        ).all()
        for row in rows:
            try:
                payload = json.loads(row[1])
            except (TypeError, json.JSONDecodeError):
                continue
            if not isinstance(payload, dict):
                continue
            payload = redact(payload)
            before = json.dumps(payload, ensure_ascii=False, sort_keys=True)
            _expire_report_evidence(payload, expired)
            after = json.dumps(payload, ensure_ascii=False, sort_keys=True)
            if before != after:
                connection.execute(
                    text(
                        "UPDATE reports SET payload=:payload WHERE id=:run AND project_id=:project"
                    ),
                    {"payload": after, "run": row[0], "project": identity},
                )


def update_finding_lifecycle(
    root: Path,
    finding_id: str,
    lifecycle_state: str,
    reason: str,
    expected_revision: int,
    actor: str = "local-user",
    expiry_days: int = 30,
) -> dict[str, Any] | None:
    """Update one finding with an optimistic revision check and report mirror."""

    load_config(root)
    engine = open_store(root)
    identity = project_id(root)
    try:
        with engine.begin() as connection:
            row = update_lifecycle(
                connection,
                identity,
                finding_id,
                lifecycle_state,
                reason,
                expected_revision,
                actor,
                expiry_days,
            )
            if row is None:
                return None
            report_row = connection.execute(
                text("SELECT id,payload FROM reports WHERE id=:run AND project_id=:project"),
                {"run": row["run_id"], "project": identity},
            ).first()
            if report_row is not None:
                payload = redact(json.loads(report_row[1]))
                for finding in payload.get("findings", []):
                    if finding.get("id") == finding_id:
                        finding["lifecycle_state"] = lifecycle_state
                        finding["revision"] = row["revision"]
                        break
                connection.execute(
                    text(
                        "UPDATE reports SET payload=:payload WHERE id=:run AND project_id=:project"
                    ),
                    {
                        "payload": json.dumps(payload, ensure_ascii=False),
                        "run": row["run_id"],
                        "project": identity,
                    },
                )
            result = dict(row)
            result.pop("project_id", None)
            result["source_ref"] = {
                "path": result.pop("source_path"),
                "line": result.pop("source_line"),
            }
            return result
    finally:
        engine.dispose()


def export_report(report: dict[str, Any], format: str) -> str:
    data = json.dumps(redact(report), indent=2, ensure_ascii=False)
    if format == "json":
        return data
    if format == "html":
        return (
            '<!doctype html><html lang="id"><meta charset="utf-8">'
            '<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;">'
            "<title>plenger report</title><h1>plenger — analisis terbatas</h1><pre>"
            + html.escape(data)
            + "</pre></html>"
        )
    raise ValueError("unsupported_export_format")


def export_stored_report(root: Path, run_id: str, format: str) -> str | None:
    """Export one stored report with complete normalized assessment history."""

    report = latest(root, run_id)
    if report is None:
        return None
    engine = open_store(root)
    try:
        report["assessments"] = list_assessments(engine, project_id(root), run_id)
    finally:
        engine.dispose()
    return export_report(report, format)
