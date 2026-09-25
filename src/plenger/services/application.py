"""Static scan runs and engine capabilities: no target execution, no hosted calls."""

import hashlib
import json
import uuid
from pathlib import Path
from typing import Any, cast

from sqlalchemy import text
from sqlalchemy.engine import Engine

from plenger.adapters.promptfoo import capability as promptfoo_capability
from plenger.adapters.python_parser import IMAGE, SandboxError, cleanup_run, execute, probe
from plenger.broker.ipc import active_runner_capability
from plenger.domain.runs import RunState
from plenger.policy.redaction import redact
from plenger.services.scanners.baseline import run_managed_scanners, scanner_findings_to_report
from plenger.services.scanners.manifest import scanner_manifest_digest
from plenger.services.scanners.verification import scanner_capabilities
from plenger.services.snapshot import manifest
from plenger.services.workspace import (
    capture,
    is_dependency_input,
    load_config,
    project_identity,
)
from plenger.storage.attempts import mark_interrupted_active_attempts
from plenger.storage.database import open_store
from plenger.storage.findings import (
    carry_forward_lifecycle,
    default_retention_until,
    evidence_digest,
    persist_report_entities,
)
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
    return project_identity(root)


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
                    if any(
                        item.get("reason") in {"too_large", "hardlink"}
                        and is_dependency_input(item.get("path", ""))
                        for item in skipped
                    ):
                        # A skipped lockfile/manifest silently narrows OSV coverage.
                        scanner_errors.append(
                            {"engine": "osv", "reason": "dependency_input_skipped"}
                        )
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
                    carry_forward_lifecycle(connection, identity, safe_report)
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
