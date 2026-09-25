"""Keyset-paged, filterable finding reads and optimistic lifecycle updates."""

import base64
import binascii
import hashlib
import hmac
import json
from pathlib import Path
from typing import Any

from sqlalchemy import text
from sqlalchemy.engine import Engine

from plenger.services.application import project_id
from plenger.services.evidence import expire_evidence
from plenger.services.integrity import redact_preserving_integrity
from plenger.services.workspace import load_config
from plenger.storage.database import latest_report_id, open_store
from plenger.storage.findings import (
    normalized_findings,
    serialize_normalized_finding,
    suppression_states,
    update_lifecycle,
)
from plenger.storage.runs import project_key

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


def apply_suppression_state(engine: Engine, identity: str, findings: list[Any]) -> None:
    """Attach active suppressions and expose expired ones, with one batched lookup."""

    items = [
        finding
        for finding in findings
        if isinstance(finding, dict) and isinstance(finding.get("fingerprint"), str)
    ]
    active, history = suppression_states(
        engine, identity, [str(finding["fingerprint"]) for finding in items]
    )
    for finding in items:
        fingerprint = str(finding["fingerprint"])
        suppression = active.get(fingerprint)
        if suppression:
            finding["suppression"] = {
                "actor": suppression["actor"],
                "reason": suppression["reason"],
                "expires_at": suppression["expires_at"],
            }
        elif finding.get("lifecycle_state") == "suppressed":
            finding["lifecycle_state"] = "open"
            finding["suppression_state"] = "expired" if fingerprint in history else "not_found"


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
        expire_evidence(engine, identity)
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
            output.append(item)
        apply_suppression_state(engine, identity, output)
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
                payload = redact_preserving_integrity(json.loads(report_row[1]))
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
