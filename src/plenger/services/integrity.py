"""Detect accidental corruption and missing references; not tamper-proof against the owner."""

import hashlib
import json
from typing import Any

from plenger.policy import redact
from plenger.storage.findings import evidence_digest
from plenger.storage.runs import digest


def _evidence_items(report: dict[str, Any]) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for finding in report.get("findings", []):
        if not isinstance(finding, dict):
            continue
        candidates = [finding.get("evidence")]
        extra = finding.get("evidence_refs")
        if isinstance(extra, list):
            candidates.extend(extra)
        items.extend(item for item in candidates if isinstance(item, dict))
    return items


def redact_preserving_integrity(report: dict[str, Any]) -> dict[str, Any]:
    """Re-redact a stored report before writing it back without false integrity alarms.

    Evidence whose stored digest still verifies is re-sealed after redaction, so a
    broader redaction rule does not look like corruption. Evidence that no longer
    verifies keeps its old digest and remains a visible mismatch.
    """

    intact = {
        str(item.get("id"))
        for item in _evidence_items(report)
        if item.get("id") and item.get("sha256_redacted") == evidence_digest(item)
    }
    redacted: dict[str, Any] = redact(report)
    for item in _evidence_items(redacted):
        if str(item.get("id")) in intact:
            item["sha256_redacted"] = evidence_digest(item)
    return redacted


def check_report(report: dict[str, Any]) -> dict[str, Any]:
    snapshot = report.get("snapshot")
    snapshot_state = "not_available"
    if isinstance(snapshot, dict):
        valid = (
            snapshot.get("id") == report.get("snapshot_id")
            and snapshot.get("project_id") == report.get("project_id")
            and isinstance(snapshot.get("files"), list)
            and snapshot.get("manifest_digest") == digest(snapshot.get("files"))
        )
        snapshot_state = "verified" if valid else "mismatch"
    report["snapshot_integrity"] = snapshot_state
    for finding in report.get("findings", []):
        evidence_items = [finding.get("evidence")]
        extra_evidence = finding.get("evidence_refs")
        if isinstance(extra_evidence, list):
            evidence_items.extend(extra_evidence)
        present_evidence = [
            evidence
            for evidence in evidence_items
            if isinstance(evidence, dict) and evidence.get("id")
        ]
        if not present_evidence:
            finding["evidence_integrity"] = "missing"
            continue
        validities: list[bool] = []
        for evidence in evidence_items:
            if not isinstance(evidence, dict) or not evidence.get("id"):
                validities.append(False)
                continue
            content = {key: value for key, value in evidence.items() if key != "sha256_redacted"}
            # v1 used standard json spacing. New records use the canonical digest helper.
            expected = (
                hashlib.sha256(json.dumps(content, sort_keys=True).encode()).hexdigest()
                if report.get("manifest", {}).get("parser") == "python-ast-v1"
                else evidence_digest(evidence)
            )
            legacy_expected = digest(content)
            validities.append(
                evidence.get("sha256_redacted") in {expected, legacy_expected}
                and evidence.get("run_id") == report.get("run_id")
                and finding.get("snapshot_id") == report.get("snapshot_id")
                and snapshot_state != "mismatch"
            )
        finding["evidence_integrity"] = (
            "verified"
            if validities and all(validities)
            else "missing"
            if not validities
            else "mismatch"
        )
    return report
