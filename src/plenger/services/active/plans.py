"""Plan creation, review and approval for a project's active runs."""

from pathlib import Path
from typing import Any, Literal, cast

from plenger.broker.dispatch import resolve_target_addresses
from plenger.policy.active import BudgetSpec, PlanSpec, TargetSpec, preview
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


def plan_from_request(
    target_ref: str,
    base_url: str,
    environment: str,
    allowed_paths: list[str],
    allowed_methods: list[str],
    auth_profile_ref: str | None,
    max_response_bytes: int,
    observability: str,
    case_ids: list[str],
    snapshot_digest: str,
    auth_identity: str,
    data_classes: list[str],
    max_cases: int,
    max_attempts: int,
    concurrency: int,
    request_timeout_seconds: int,
    wall_time_seconds: int,
    cost_guard: str,
    cost_acknowledged: bool,
) -> PlanSpec:
    target = TargetSpec(
        target_ref=target_ref,
        base_url=base_url,
        environment=cast(Literal["local", "staging"], environment),
        allowed_paths=allowed_paths,
        allowed_methods=allowed_methods,  # type: ignore[arg-type]
        auth_profile_ref=auth_profile_ref,
        max_response_bytes=max_response_bytes,
        observability=cast(Literal["none", "trace"], observability),
    )
    return PlanSpec(
        target=target,
        case_ids=case_ids,
        snapshot_digest=snapshot_digest,
        auth_identity=auth_identity,
        data_classes=cast(
            list[Literal["metadata", "code_excerpt", "prompt", "response", "trace"]],
            data_classes,
        ),
        budget=BudgetSpec(
            max_cases=max_cases,
            max_attempts=max_attempts,
            concurrency=concurrency,
            request_timeout_seconds=request_timeout_seconds,
            wall_time_seconds=wall_time_seconds,
            cost_guard=cast(Literal["strict", "request_only"], cost_guard),
            cost_acknowledged=cost_acknowledged,
        ),
    )
