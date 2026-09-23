import pytest

from plenger.services.application import ci_exit_code
from plenger.services.diff import diff_reports


def report(run_id, fingerprints, *, state="completed", profile="deterministic"):
    return {
        "run_id": run_id,
        "project_id": "p",
        "profile": profile,
        "state": state,
        "errors": [],
        "manifest": {"parser": "python-ast-v2"},
        "findings": [
            {
                "id": f"{index:064x}",
                "fingerprint": fingerprint,
                "severity": "high",
                "validation_state": "candidate",
            }
            for index, fingerprint in enumerate(fingerprints, 1)
        ],
    }


def test_diff_is_conservative_for_partial_scan():
    result = diff_reports(
        report("old", ["a", "b"]), report("new", ["b"], state="completed_with_errors")
    )
    statuses = {item["fingerprint"]: item["status"] for item in result["items"]}
    assert statuses == {"a": "not_observed", "b": "recurring"}


def test_diff_marks_absent_finding_resolved_only_after_complete_comparable_scan():
    result = diff_reports(report("old", ["a"]), report("new", []))
    assert result["items"][0]["status"] == "resolved"
    assert not diff_reports(report("old", ["a"]), report("new", [], profile="other"))["comparable"]


def test_diff_rejects_changed_worker_or_scanner_identity():
    previous = report("old", ["a"])
    current = report("new", ["a"])
    previous["manifest"].update({"image": "python@sha256:old", "worker_sha256": "old"})
    current["manifest"].update({"image": "python@sha256:new", "worker_sha256": "new"})
    assert diff_reports(previous, current) == {
        "comparable": False,
        "reason": "analysis_identity_changed",
        "items": [],
    }

    previous = report("old", ["a"])
    current = report("new", ["a"])
    previous["scanner_results"] = [
        {"engine": "semgrep", "manifest": {"engine_version": "1.0", "binary_hash": "a"}}
    ]
    current["scanner_results"] = [
        {
            "engine": "semgrep",
            "manifest": {
                "engine_version": "2.0",
                "binary_hash": "b",
                "supported_patterns": ["python_ast_rules"],
            },
        }
    ]
    assert diff_reports(previous, current)["reason"] == "analysis_identity_changed"

    previous = report("old", ["a"])
    current = report("new", ["a"])
    previous["scanner_results"] = [
        {
            "engine": "semgrep",
            "manifest": {
                "engine_version": "1.0",
                "binary_hash": "a",
                "supported_patterns": ["python_ast_rules"],
            },
        }
    ]
    current["scanner_results"] = [
        {
            "engine": "semgrep",
            "manifest": {
                "engine_version": "1.0",
                "binary_hash": "a",
                "supported_patterns": ["python_ast_rules_v2"],
            },
        }
    ]
    assert diff_reports(previous, current)["reason"] == "analysis_identity_changed"


@pytest.mark.parametrize("lifecycle", ["resolved", "suppressed"])
def test_diff_marks_returning_active_finding_reopened(lifecycle):
    previous = report("old", ["a"])
    previous["findings"][0]["lifecycle_state"] = lifecycle
    current = report("new", ["a"])
    assert diff_reports(previous, current)["items"][0]["status"] == "reopened"


def test_diff_covers_new_recurring_resolved_not_observed_and_rule_changes():
    previous = report("old", ["recurring", "resolved", "partial", "reopened"])
    previous["findings"][1]["lifecycle_state"] = "open"
    previous["findings"][3]["lifecycle_state"] = "resolved"
    current = report("new", ["new", "recurring", "reopened"], state="completed_with_errors")
    statuses = {
        item["fingerprint"]: item["status"] for item in diff_reports(previous, current)["items"]
    }
    assert statuses == {
        "new": "new",
        "partial": "not_observed",
        "recurring": "recurring",
        "reopened": "reopened",
        "resolved": "not_observed",
    }

    complete_current = report("new-complete", ["new", "recurring", "reopened"])
    complete_statuses = {
        item["fingerprint"]: item["status"]
        for item in diff_reports(previous, complete_current)["items"]
    }
    assert complete_statuses["resolved"] == "resolved"

    previous_identity = report("old-identity", ["a"])
    current_identity = report("new-identity", ["a"])
    previous_identity["manifest"]["rule_digest"] = "old-rule"
    current_identity["manifest"]["rule_digest"] = "new-rule"
    assert diff_reports(previous_identity, current_identity)["reason"] == (
        "analysis_identity_changed"
    )


def test_ci_only_fails_on_supported_or_confirmed():
    candidate = report("run", ["a"])
    assert ci_exit_code(candidate, "high") == 0
    candidate["findings"][0]["validation_state"] = "confirmed"
    assert ci_exit_code(candidate, "high") == 1
    assert ci_exit_code(report("run", [], state="completed_with_errors"), "high") == 2
    assert ci_exit_code(report("run", [], state="blocked"), "high") == 3
    assert ci_exit_code(report("run", [], state="interrupted"), "high") == 130
    assert ci_exit_code(report("run", [], state="cancelled"), "high") == 130
    with pytest.raises(ValueError):
        ci_exit_code(candidate, "urgent")


@pytest.mark.parametrize("error_field", ["errors", "scanner_errors"])
def test_ci_fails_closed_when_completed_report_contains_errors(error_field):
    current = report("run", [], state="completed")
    current[error_field] = [{"reason": "synthetic"}]
    assert ci_exit_code(current, "high") == 2


def test_ci_severity_comparison_normalizes_reported_severity():
    current = report("run", ["a"])
    current["findings"][0]["validation_state"] = "supported"
    current["findings"][0]["severity"] = "HIGH"
    assert ci_exit_code(current, "high") == 1


@pytest.mark.parametrize(
    ("state", "validation_state", "severity", "fail_on", "error_field", "expected"),
    [
        ("completed", "candidate", "critical", "high", None, 0),
        ("completed", "supported", "low", "high", None, 0),
        ("completed", "supported", "high", "high", None, 1),
        ("completed", "confirmed", "critical", "critical", None, 1),
        ("completed", "supported", "high", "high", "errors", 2),
        ("completed", "confirmed", "critical", "critical", "scanner_errors", 2),
        ("completed_with_errors", "supported", "high", "high", None, 2),
        ("blocked", "supported", "high", "high", None, 3),
        ("failed", "supported", "high", "high", None, 2),
        ("queued", "supported", "high", "high", None, 2),
        ("interrupted", "supported", "high", "high", None, 130),
        ("cancelled", "supported", "high", "high", None, 130),
        ("completed", "confirmed", "critical", None, None, 0),
        ("completed", "supported", "unknown", "high", None, 0),
        ("completed", "supported", "info", "info", None, 1),
        ("completed", "supported", "medium", "low", None, 1),
    ],
)
def test_ci_exit_code_complete_policy_matrix(
    state, validation_state, severity, fail_on, error_field, expected
):
    current = report("run", ["a"], state=state)
    current["findings"][0]["validation_state"] = validation_state
    current["findings"][0]["severity"] = severity
    if error_field is not None:
        current[error_field] = [{"reason": "synthetic"}]

    assert ci_exit_code(current, fail_on) == expected
