"""Normalized finding/evidence persistence with project-bound queries."""

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any, cast

from sqlalchemy import text
from sqlalchemy.engine import Connection, Engine

from plenger.policy.redaction import redact
from plenger.storage.runs import digest, now


def evidence_digest(evidence: dict[str, Any]) -> str:
    """Hash stable redacted artifact content, excluding run-local metadata."""

    return digest(
        {
            "source": str(evidence.get("source", "unknown")),
            "observed": str(evidence.get("observed", "")),
            "redaction_version": str(evidence.get("redaction_version", "unknown")),
            "mime": str(evidence.get("mime", "text/plain")),
        }
    )


_CARRY_FORWARD_CHUNK = 500


def carry_forward_lifecycle(
    connection: Connection, project_id: str, report: dict[str, Any]
) -> None:
    """Carry reviewer triage onto recurring findings of a new run, by fingerprint.

    An active suppression keeps a recurring finding suppressed and an earlier
    acknowledgment stays acknowledged. ``resolved`` is deliberately not carried:
    a resolved finding that reappears must surface as reopened.
    """

    findings = [
        finding
        for finding in report.get("findings", [])
        if isinstance(finding, dict) and isinstance(finding.get("fingerprint"), str)
    ]
    fingerprints = sorted({str(finding["fingerprint"]) for finding in findings})
    if not fingerprints:
        return
    run_id = str(report.get("run_id", ""))
    current = datetime.now(UTC).isoformat()
    suppressed: set[str] = set()
    latest_state: dict[str, tuple[str, str]] = {}
    for start in range(0, len(fingerprints), _CARRY_FORWARD_CHUNK):
        chunk = fingerprints[start : start + _CARRY_FORWARD_CHUNK]
        names = {f"f{index}": value for index, value in enumerate(chunk)}
        placeholders = ",".join(f":{name}" for name in names)
        suppressed.update(
            str(value)
            for value in connection.execute(
                text(
                    "SELECT DISTINCT finding_fingerprint FROM finding_suppressions "
                    "WHERE project_id=:project AND revoked_at IS NULL AND expires_at>:current "
                    f"AND finding_fingerprint IN ({placeholders})"
                ),
                {"project": project_id, "current": current, **names},
            ).scalars()
        )
        rows = connection.execute(
            text(
                "SELECT fingerprint,lifecycle_state,updated_at FROM finding_records "
                f"WHERE project_id=:project AND run_id<>:run AND fingerprint IN ({placeholders})"
            ),
            {"project": project_id, "run": run_id, **names},
        ).all()
        for fingerprint, lifecycle_state, updated_at in rows:
            previous = latest_state.get(str(fingerprint))
            if previous is None or str(updated_at) > previous[1]:
                latest_state[str(fingerprint)] = (str(lifecycle_state), str(updated_at))
    for finding in findings:
        fingerprint = str(finding["fingerprint"])
        if fingerprint in suppressed:
            finding["lifecycle_state"] = "suppressed"
        elif latest_state.get(fingerprint, ("", ""))[0] == "acknowledged":
            finding["lifecycle_state"] = "acknowledged"


def persist_report_entities(connection: Connection, report: dict[str, Any]) -> None:
    """Persist redacted finding rows without making the JSON report authoritative."""

    report = redact(report)
    run_id = report.get("run_id")
    project_id = report.get("project_id")
    snapshot_id = report.get("snapshot_id")
    if not all(isinstance(value, str) for value in (run_id, project_id, snapshot_id)):
        return
    timestamp = now()
    for finding in report.get("findings", []):
        evidence = finding.get("evidence")
        source_ref = finding.get("source_ref")
        if not isinstance(evidence, dict) or not isinstance(source_ref, dict):
            continue
        evidence_items = [evidence]
        extra_evidence = finding.get("evidence_refs")
        if isinstance(extra_evidence, list):
            evidence_items.extend(item for item in extra_evidence if isinstance(item, dict))
        unique_evidence: list[dict[str, Any]] = []
        seen_evidence: set[str] = set()
        for item in evidence_items:
            evidence_id = item.get("id")
            if not isinstance(evidence_id, str) or evidence_id in seen_evidence:
                continue
            seen_evidence.add(evidence_id)
            unique_evidence.append(item)
        finding_id = finding.get("id")
        if not isinstance(finding_id, str) or not unique_evidence:
            continue
        connection.execute(
            text(
                "INSERT INTO finding_records "
                "(id,run_id,project_id,snapshot_id,fingerprint,rule_id,kind,severity,"
                "severity_source,validation_state,lifecycle_state,assessment_state,title,"
                "source_path,source_line,revision,created_at,updated_at) "
                "VALUES (:id,:run,:project,:snapshot,:fingerprint,:rule,:kind,:severity,"
                ":severity_source,:validation,:lifecycle,:assessment,:title,:path,:line,0,:created,:created)"
            ),
            {
                "id": finding_id,
                "run": run_id,
                "project": project_id,
                "snapshot": snapshot_id,
                "fingerprint": str(finding.get("fingerprint", "")),
                "rule": str(finding.get("rule_id", "unknown")),
                "kind": str(finding.get("kind", "unknown")),
                "severity": str(finding.get("severity", "unknown")),
                "severity_source": str(finding.get("severity_source", "unknown")),
                "validation": str(finding.get("validation_state", "candidate")),
                "lifecycle": str(finding.get("lifecycle_state", "open")),
                "assessment": str(finding.get("assessment_state", "needs_review")),
                "title": str(finding.get("title", "")),
                "path": str(source_ref.get("path", "")),
                "line": int(source_ref.get("line", 1)),
                "created": timestamp,
            },
        )
        for evidence_order, evidence in enumerate(unique_evidence):
            evidence_id = evidence["id"]
            retention_until = evidence.get("retention_until") or default_retention_until()
            connection.execute(
                text(
                    "INSERT INTO evidence_artifacts "
                    "(id,run_id,project_id,source,observed,redaction_version,"
                    "sha256_redacted,mime,size,retention_until,created_at) "
                    "VALUES (:id,:run,:project,:source,:observed,:redaction,:digest,"
                    ":mime,:size,:retention,:created)"
                ),
                {
                    "id": evidence_id,
                    "run": run_id,
                    "project": project_id,
                    "source": str(evidence.get("source", "unknown")),
                    "observed": str(evidence.get("observed", "")),
                    "redaction": str(evidence.get("redaction_version", "unknown")),
                    "digest": str(evidence.get("sha256_redacted", "")),
                    "mime": str(evidence.get("mime", "text/plain")),
                    "size": len(str(evidence.get("observed", "")).encode()),
                    "retention": retention_until,
                    "created": timestamp,
                },
            )
            connection.execute(
                text(
                    "INSERT INTO finding_evidence "
                    "(finding_id,evidence_id,project_id,evidence_order) "
                    "VALUES (:finding,:evidence,:project,:evidence_order)"
                ),
                {
                    "finding": finding_id,
                    "evidence": evidence_id,
                    "project": project_id,
                    "evidence_order": evidence_order,
                },
            )


def normalized_findings(
    engine: Engine,
    project_id: str,
    run_id: str | None = None,
    limit: int = 100,
    offset: int = 0,
    after: tuple[str, int, str] | None = None,
    fetch_extra: bool = False,
    filters: dict[str, str] | None = None,
) -> list[dict[str, Any]]:
    """Read findings in stable source order, optionally after a keyset cursor."""

    if not 1 <= limit <= 100 or offset < 0:
        raise ValueError("invalid_finding_pagination")
    if after is not None:
        if (
            offset != 0
            or len(after) != 3
            or not isinstance(after[0], str)
            or not isinstance(after[1], int)
            or not isinstance(after[2], str)
        ):
            raise ValueError("invalid_finding_pagination")
    allowed_filters = {
        "severity": "severity",
        "validation_state": "validation_state",
        "lifecycle_state": "lifecycle_state",
        "kind": "kind",
        "source_path": "source_path",
    }
    requested_filters = filters or {}
    if any(
        name not in allowed_filters or not isinstance(value, str) or not value or len(value) > 256
        for name, value in requested_filters.items()
    ):
        raise ValueError("invalid_finding_filter")
    query_limit = limit + 1 if fetch_extra else limit
    query = (
        "SELECT f.*, e.id AS evidence_id, e.source AS evidence_source, "
        "e.observed AS evidence_observed, e.redaction_version AS evidence_redaction, "
        "e.sha256_redacted AS evidence_digest, e.mime AS evidence_mime, "
        "e.size AS evidence_size, e.retention_until AS evidence_retention "
        "FROM finding_records f JOIN finding_evidence fe ON fe.finding_id=f.id "
        "JOIN evidence_artifacts e ON e.id=fe.evidence_id "
        "WHERE f.project_id=:project "
        "AND f.id IN (SELECT fr.id FROM finding_records fr WHERE fr.project_id=:project"
    )
    values: dict[str, Any] = {"project": project_id, "limit": query_limit, "offset": offset}
    if run_id is not None:
        query += " AND fr.run_id=:run"
        values["run"] = run_id
    for name, column in allowed_filters.items():
        if name in requested_filters:
            query += f" AND fr.{column}=:{name}"
            values[name] = requested_filters[name]
    if after is not None:
        query += (
            " AND (fr.source_path > :after_path "
            "OR (fr.source_path = :after_path AND fr.source_line > :after_line) "
            "OR (fr.source_path = :after_path AND fr.source_line = :after_line "
            "AND fr.id > :after_id))"
        )
        values.update({"after_path": after[0], "after_line": after[1], "after_id": after[2]})
    query += " ORDER BY fr.source_path, fr.source_line, fr.id LIMIT :limit OFFSET :offset)"
    query += " ORDER BY f.source_path, f.source_line, f.id, fe.evidence_order, e.id"
    with engine.connect() as connection:
        rows = connection.execute(text(query), values).mappings().all()
    output: list[dict[str, Any]] = []
    by_finding: dict[str, dict[str, Any]] = {}
    for row in rows:
        item = dict(row)
        evidence = redact(
            {
                "id": item.pop("evidence_id"),
                "source": item.pop("evidence_source"),
                "observed": item.pop("evidence_observed"),
                "redaction_version": item.pop("evidence_redaction"),
                "sha256_redacted": item.pop("evidence_digest"),
                "mime": item.pop("evidence_mime"),
                "size": item.pop("evidence_size"),
                "retention_until": item.pop("evidence_retention"),
            }
        )
        finding_id = str(item["id"])
        existing = by_finding.get(finding_id)
        if existing is None:
            item["source_ref"] = {
                "path": item.pop("source_path"),
                "line": item.pop("source_line"),
            }
            item = cast(dict[str, Any], redact(item))
            item["evidence"] = evidence
            item["_evidence_refs"] = [evidence]
            by_finding[finding_id] = item
            output.append(item)
        else:
            existing_refs = existing["_evidence_refs"]
            assert isinstance(existing_refs, list)
            existing_refs.append(evidence)
    for item in output:
        refs = item.pop("_evidence_refs")
        if isinstance(refs, list) and len(refs) > 1:
            item["evidence_refs"] = refs
    return output


def update_lifecycle(
    connection: Connection,
    project_id: str,
    finding_id: str,
    lifecycle_state: str,
    reason: str,
    expected_revision: int,
    actor: str = "local-user",
    expiry_days: int = 30,
) -> dict[str, Any] | None:
    if lifecycle_state not in {"open", "acknowledged", "suppressed", "resolved"}:
        raise ValueError("invalid_lifecycle_state")
    if not reason.strip() or len(reason) > 1000:
        raise ValueError("lifecycle_reason_required")
    safe_reason = str(redact(reason.strip()))[:1000]
    if not actor or len(actor) > 128:
        raise ValueError("invalid_lifecycle_actor")
    safe_actor = str(redact(actor))[:128]
    if not 1 <= expiry_days <= 365:
        raise ValueError("invalid_suppression_expiry")
    result = connection.execute(
        text(
            "UPDATE finding_records SET lifecycle_state=:state, revision=revision+1, "
            "updated_at=:updated WHERE id=:id AND project_id=:project AND revision=:revision"
        ),
        {
            "state": lifecycle_state,
            "updated": now(),
            "id": finding_id,
            "project": project_id,
            "revision": expected_revision,
        },
    )
    if result.rowcount != 1:
        return None
    if lifecycle_state == "suppressed":
        finding = (
            connection.execute(
                text(
                    "SELECT fingerprint FROM finding_records WHERE id=:id AND project_id=:project"
                ),
                {"id": finding_id, "project": project_id},
            )
            .mappings()
            .first()
        )
        if finding is None:
            return None
        timestamp = datetime.now(UTC)
        connection.execute(
            text(
                "INSERT INTO finding_suppressions "
                "(id,project_id,finding_fingerprint,actor,reason,scope_fingerprint,"
                "evidence_id,created_at,expires_at,revoked_at) "
                "VALUES (:id,:project,:fingerprint,:actor,:reason,:scope,NULL,"
                ":created,:expires,NULL)"
            ),
            {
                "id": str(uuid.uuid4()),
                "project": project_id,
                "fingerprint": finding["fingerprint"],
                "actor": safe_actor,
                "reason": safe_reason,
                "scope": finding["fingerprint"],
                "created": timestamp.isoformat(),
                "expires": (timestamp + timedelta(days=expiry_days)).isoformat(),
            },
        )
    # Keep a bounded audit trail in the event table's reason column for the run.
    sequence = connection.execute(
        text(
            "SELECT COALESCE(MAX(sequence), -1) + 1 FROM run_events "
            "WHERE run_id=(SELECT run_id FROM finding_records WHERE id=:id)"
        ),
        {"id": finding_id},
    ).scalar_one()
    connection.execute(
        text(
            "INSERT INTO run_events (run_id,sequence,state,reason,created_at) "
            "SELECT run_id,:sequence,'lifecycle',:reason,:updated "
            "FROM finding_records WHERE id=:id"
        ),
        {"sequence": sequence, "reason": safe_reason, "updated": now(), "id": finding_id},
    )
    row = (
        connection.execute(
            text("SELECT * FROM finding_records WHERE id=:id AND project_id=:project"),
            {"id": finding_id, "project": project_id},
        )
        .mappings()
        .first()
    )
    return cast(dict[str, Any], redact(dict(row))) if row else None


def active_suppression(
    engine: Engine, project_id: str, fingerprint: str, now_value: str | None = None
) -> dict[str, Any] | None:
    current = now_value or datetime.now(UTC).isoformat()
    with engine.connect() as connection:
        row = (
            connection.execute(
                text(
                    "SELECT * FROM finding_suppressions WHERE project_id=:project "
                    "AND finding_fingerprint=:fingerprint AND revoked_at IS NULL "
                    "AND expires_at > :current ORDER BY expires_at DESC LIMIT 1"
                ),
                {"project": project_id, "fingerprint": fingerprint, "current": current},
            )
            .mappings()
            .first()
        )
    return cast(dict[str, Any], redact(dict(row))) if row else None


def default_retention_until(days: int = 30) -> str:
    if not 1 <= days <= 3650:
        raise ValueError("invalid_retention_days")
    return (datetime.now(UTC) + timedelta(days=days)).isoformat()


def purge_expired_evidence(
    engine: Engine, project_id: str, now_value: str | None = None
) -> set[str]:
    current = now_value or datetime.now(UTC).isoformat()
    with engine.begin() as connection:
        rows = (
            connection.execute(
                text(
                    "SELECT id FROM evidence_artifacts WHERE project_id=:project "
                    "AND retention_until IS NOT NULL AND retention_until<=:current "
                    "AND observed<>'[EXPIRED]'"
                ),
                {"project": project_id, "current": current},
            )
            .scalars()
            .all()
        )
        if rows:
            connection.execute(
                text(
                    "UPDATE evidence_artifacts SET observed='[EXPIRED]',size=0 "
                    "WHERE project_id=:project AND retention_until IS NOT NULL "
                    "AND retention_until<=:current"
                ),
                {"project": project_id, "current": current},
            )
    return {str(item) for item in rows}


def expired_evidence_ids(
    engine: Engine,
    project_id: str,
    now_value: str | None = None,
    run_id: str | None = None,
) -> set[str]:
    current = now_value or datetime.now(UTC).isoformat()
    query = (
        "SELECT id FROM evidence_artifacts WHERE project_id=:project "
        "AND retention_until IS NOT NULL AND retention_until<=:current"
    )
    values = {"project": project_id, "current": current}
    if run_id is not None:
        query += " AND run_id=:run"
        values["run"] = run_id
    with engine.connect() as connection:
        rows = connection.execute(text(query), values).scalars().all()
    return {str(item) for item in rows}


def suppression_states(
    engine: Engine, project_id: str, fingerprints: list[str], now_value: str | None = None
) -> tuple[dict[str, dict[str, Any]], set[str]]:
    """Batch-load active suppressions and suppression history for many findings."""

    current = now_value or datetime.now(UTC).isoformat()
    unique = sorted(set(fingerprints))
    active: dict[str, dict[str, Any]] = {}
    history: set[str] = set()
    with engine.connect() as connection:
        for start in range(0, len(unique), _CARRY_FORWARD_CHUNK):
            chunk = unique[start : start + _CARRY_FORWARD_CHUNK]
            names = {f"f{index}": value for index, value in enumerate(chunk)}
            placeholders = ",".join(f":{name}" for name in names)
            rows = (
                connection.execute(
                    text(
                        "SELECT * FROM finding_suppressions WHERE project_id=:project "
                        f"AND finding_fingerprint IN ({placeholders}) "
                        "ORDER BY expires_at DESC"
                    ),
                    {"project": project_id, **names},
                )
                .mappings()
                .all()
            )
            for row in rows:
                fingerprint = str(row["finding_fingerprint"])
                history.add(fingerprint)
                if (
                    row["revoked_at"] is None
                    and str(row["expires_at"]) > current
                    and fingerprint not in active
                ):
                    active[fingerprint] = cast(dict[str, Any], redact(dict(row)))
    return active, history


def latest_suppression(engine: Engine, project_id: str, fingerprint: str) -> dict[str, Any] | None:
    with engine.connect() as connection:
        row = (
            connection.execute(
                text(
                    "SELECT * FROM finding_suppressions WHERE project_id=:project "
                    "AND finding_fingerprint=:fingerprint ORDER BY created_at DESC LIMIT 1"
                ),
                {"project": project_id, "fingerprint": fingerprint},
            )
            .mappings()
            .first()
        )
    return cast(dict[str, Any], redact(dict(row))) if row else None


def serialize_normalized_finding(item: dict[str, Any]) -> dict[str, Any]:
    """Convert a normalized row to the public finding shape."""

    result = dict(item)
    result.pop("project_id", None)
    result.pop("run_id", None)
    result.pop("snapshot_id", None)
    source_path = result.pop("source_path", None)
    source_line = result.pop("source_line", None)
    if source_path is not None:
        result["source_ref"] = {"path": source_path, "line": source_line}
    return result
