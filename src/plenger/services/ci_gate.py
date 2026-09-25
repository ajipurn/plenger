"""CI exit codes for a finished report and its optional severity gate."""

from typing import Any

_SEVERITY_LEVELS = {"info": 0, "low": 1, "medium": 2, "high": 3, "critical": 4}
_GATED_VALIDATION_STATES = frozenset({"supported", "confirmed"})


def _severity_threshold(fail_on: str) -> int:
    threshold = _SEVERITY_LEVELS.get(fail_on.lower())
    if threshold is None:
        raise ValueError("invalid_fail_on_severity")
    return threshold


def _gated_findings(
    report: dict[str, Any], threshold: int, include_candidates: bool
) -> list[dict[str, Any]]:
    states = _GATED_VALIDATION_STATES | ({"candidate"} if include_candidates else set())
    return [
        finding
        for finding in report.get("findings", [])
        if isinstance(finding, dict)
        and finding.get("validation_state") in states
        and finding.get("lifecycle_state") not in {"suppressed", "resolved"}
        and _SEVERITY_LEVELS.get(str(finding.get("severity", "")).lower(), -1) >= threshold
    ]


def ungated_candidate_count(report: dict[str, Any], fail_on: str | None) -> int:
    """Count candidates at/above the threshold that a supported-only gate ignores."""

    if fail_on is None:
        return 0
    threshold = _severity_threshold(fail_on)
    return len(_gated_findings(report, threshold, True)) - len(
        _gated_findings(report, threshold, False)
    )


def ci_exit_code(
    report: dict[str, Any], fail_on: str | None = None, *, include_candidates: bool = False
) -> int:
    """Map a report to CI semantics.

    By default only supported/confirmed findings fail the severity gate. Static
    scanners emit review candidates, so a gate that must stop the pipeline on scanner
    output needs ``include_candidates``. Active runs fail on any failed fixed case.
    """

    state = report.get("state")
    if state in {"cancelled", "interrupted"}:
        return 130
    if state == "blocked":
        return 3
    if state != "completed":
        return 2
    if report.get("errors") or report.get("scanner_errors"):
        return 2
    if any(
        isinstance(item, dict) and item.get("result") == "fail"
        for item in report.get("test_results", [])
    ):
        return 1
    if fail_on is None:
        return 0
    threshold = _severity_threshold(fail_on)
    return 1 if _gated_findings(report, threshold, include_candidates) else 0
