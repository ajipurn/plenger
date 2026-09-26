"""Plan creation, review and approval for a project's active runs."""

from pathlib import Path
from typing import Any, cast

from plenger.broker.dispatch import resolve_target_addresses
from plenger.policy.active import PlanSpec, preview
from plenger.policy.redaction import redact
from plenger.runner.cases import validate_case_ids
from plenger.services.application import project_id
from plenger.services.workspace import load_config
from plenger.storage.database import open_store
from plenger.storage.plans import approve_plan, create_plan, get_plan, revoke_plan


def plan_for_project(root: Path, plan: PlanSpec) -> dict[str, Any]:
    load_config(root)
    validate_case_ids(plan.case_ids)
    if plan.budget.cost_guard == "strict":
        # No trusted target-side cost control exists yet, so a strict plan could be
        # approved but never run. Reject it before the user reviews and approves it.
        raise ValueError("strict_cost_guard_requires_target_control")
    addresses = resolve_target_addresses(plan.target)
    plan = plan.model_copy(
        update={
            "target": plan.target.model_copy(
                update={"allowed_ips": [str(address) for address in addresses]}
            )
        }
    )
    engine = open_store(root)
    identity = project_id(root)
    try:
        result, _created = create_plan(engine, identity, plan)
        result["preview"] = preview(plan, identity)
        result["target_revision"] = plan.target.digest()
        return cast(dict[str, Any], redact(result))
    finally:
        engine.dispose()


def approve_for_project(
    root: Path,
    plan_id: str,
    actor: str,
    acknowledgment: str,
    ttl_minutes: int,
) -> dict[str, Any]:
    load_config(root)
    engine = open_store(root)
    try:
        return approve_plan(engine, project_id(root), plan_id, actor, acknowledgment, ttl_minutes)
    finally:
        engine.dispose()


def get_project_plan(root: Path, plan_id: str) -> dict[str, Any] | None:
    load_config(root)
    engine = open_store(root)
    try:
        current = get_plan(engine, project_id(root), plan_id)
        return cast(dict[str, Any], redact(current)) if current is not None else None
    finally:
        engine.dispose()


def revoke_project_plan(root: Path, plan_id: str) -> bool:
    load_config(root)
    engine = open_store(root)
    try:
        return revoke_plan(engine, project_id(root), plan_id)
    finally:
        engine.dispose()
