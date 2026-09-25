"""Retention expiry for stored evidence and the report mirrors that quote it."""

import json
from typing import Any

from sqlalchemy import text
from sqlalchemy.engine import Engine

from plenger.services.integrity import redact_preserving_integrity
from plenger.storage.runs import now


def expire_evidence(engine: Engine, identity: str) -> None:
    """Scrub newly expired evidence and only the report mirrors that reference it.

    Evidence rows and their mirrors change in one transaction, so a crash cannot
    leave a mirror holding content whose normalized row was already scrubbed.
    """

    current = now()
    expiry_filter = (
        "project_id=:project AND retention_until IS NOT NULL "
        "AND retention_until<=:current AND observed<>'[EXPIRED]'"
    )
    values = {"project": identity, "current": current}
    # A read-only probe keeps ordinary dashboard reads from taking the writer lock.
    with engine.connect() as connection:
        pending = connection.execute(
            text(f"SELECT 1 FROM evidence_artifacts WHERE {expiry_filter} LIMIT 1"), values
        ).first()
    if pending is None:
        return
    with engine.begin() as connection:
        rows = connection.execute(
            text(
                "UPDATE evidence_artifacts SET observed='[EXPIRED]',size=0 "
                f"WHERE {expiry_filter} RETURNING id,run_id"
            ),
            values,
        ).all()
        by_run: dict[str, set[str]] = {}
        for evidence_id, evidence_run in rows:
            by_run.setdefault(str(evidence_run), set()).add(str(evidence_id))
        for evidence_run, expired in by_run.items():
            row = connection.execute(
                text("SELECT payload FROM reports WHERE id=:run AND project_id=:project"),
                {"run": evidence_run, "project": identity},
            ).first()
            if row is None:
                continue
            try:
                payload = json.loads(row[0])
            except (TypeError, json.JSONDecodeError):
                continue
            if not isinstance(payload, dict):
                continue
            payload = redact_preserving_integrity(payload)
            expire_report_evidence(payload, expired)
            connection.execute(
                text("UPDATE reports SET payload=:payload WHERE id=:run AND project_id=:project"),
                {
                    "payload": json.dumps(payload, ensure_ascii=False),
                    "run": evidence_run,
                    "project": identity,
                },
            )


def expire_report_evidence(report: dict[str, Any], expired: set[str]) -> None:
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
