"""Detect accidental corruption and missing references; not tamper-proof against the owner."""

import hashlib
import json
from typing import Any

from plenger.storage.findings import evidence_digest
from plenger.storage.runs import digest


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
