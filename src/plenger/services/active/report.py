"""The report written for a finished, cancelled or failed active run."""

from pathlib import Path
from typing import Any

from plenger.policy.active import PlanSpec
from plenger.runner.cases import FIXED_CASES
from plenger.services.application import capabilities
from plenger.storage.runs import now


def active_report(
    root: Path,
    run: dict[str, Any],
    plan: PlanSpec,
    results: list[dict[str, Any]],
    stats: dict[str, Any],
    state: str,
    identity: str,
) -> dict[str, Any]:
    category_states: dict[str, str] = {}
    for item in results:
        category = item["category"]
        result = item["result"]
        category_states[category] = (
            result if result in {"blocked", "error", "inconclusive", "skipped"} else "executed"
        )
    selected_categories = {FIXED_CASES[case_id].category for case_id in plan.case_ids}
    coverage = [
        {
            "category": category,
            # Selected cases that never ran (cancel/timeout) stay "planned";
            # categories outside the approved selection were never going to run.
            "state": category_states.get(
                category, "planned" if category in selected_categories else "not_tested"
            ),
        }
        for category in (f"LLM{index:02d}" for index in range(1, 11))
    ]
    summary = {
        outcome: sum(1 for item in results if item["result"] == outcome)
        for outcome in ("pass", "fail", "error", "inconclusive", "blocked", "skipped")
    }
    summary["not_run"] = len(plan.case_ids) - len(results)
    return {
        "schema_version": 1,
        "active": True,
        # Inputs are synthetic fixed cases, but the target is a user-approved endpoint,
        # not plenger's synthetic demonstration code.
        "fixture": False,
        "synthetic_cases": True,
        "run_id": run["id"],
        "snapshot_id": None,
        "plan_id": run["plan_id"],
        "approval_id": run["approval_id"],
        "project_id": identity,
        "created_at": now(),
        "profile": plan.profile,
        "profile_digest": plan.profile_digest(),
        "rubric_hash": plan.rubric_hash,
        "case_ids": list(plan.case_ids),
        "case_count": len(plan.case_ids),
        "state": state,
        "nodes": [],
        "edges": [],
        "findings": [],
        "errors": [item for item in results if item["result"] == "error"],
        "limitations": [
            "Fixed local/staging suite only; no production target mode",
            "Pass/fail applies only to the selected fixed cases",
        ],
        "coverage": coverage,
        "engine_states": capabilities(root),
        "assessments": [],
        "test_results": results,
        "summary": summary,
        "accounting": {
            "reserved_attempts": stats["reserved_attempts"],
            "cost": None,
            "cost_status": "unknown",
            "cost_guard": plan.budget.cost_guard,
        },
    }
