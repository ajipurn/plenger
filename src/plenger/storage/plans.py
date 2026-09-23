"""Transactional plan and approval operations."""

import json
import secrets
import uuid
from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from typing import Any, cast

from sqlalchemy import text
from sqlalchemy.engine import Connection, Engine

from plenger.policy import redact
from plenger.policy.active import PlanSpec
from plenger.storage.runs import RunConflict, digest, now


def _expires(ttl_minutes: int) -> str:
    return (datetime.now(UTC) + timedelta(minutes=ttl_minutes)).isoformat()


def create_plan(engine: Engine, project_id: str, plan: PlanSpec) -> tuple[dict[str, Any], bool]:
    plan_digest = plan.digest(project_id)
    scope_digest = plan.scope_digest(project_id)
    target_revision = plan.target.digest()
    plan_id = str(uuid.uuid4())
    timestamp = now()
    payload = json.dumps(plan.model_dump(), ensure_ascii=False, sort_keys=True)
    with engine.begin() as connection:
        connection.execute(
            text(
                "INSERT OR IGNORE INTO projects (id,created_at,content_key) "
                "VALUES (:project,:created,:key)"
            ),
            {"project": project_id, "created": timestamp, "key": secrets.token_bytes(32)},
        )
        previous = (
            connection.execute(
                text(
                    "SELECT id,payload,state,revision,created_at,updated_at FROM plans "
                    "WHERE project_id=:project AND plan_digest=:digest "
                    "AND state IN ('draft','approved')"
                ),
                {"project": project_id, "digest": plan_digest},
            )
            .mappings()
            .first()
        )
        if previous:
            result = dict(previous) | {
                "plan_digest": plan_digest,
                "scope_digest": scope_digest,
            }
            result["payload"] = json.loads(result["payload"])
            return result, False
        connection.execute(
            text(
                "INSERT INTO plans "
                "(id,project_id,snapshot_digest,target_revision,plan_digest,scope_digest,profile,payload,state,"
                "revision,created_at,updated_at) "
                "VALUES (:id,:project,:snapshot,:target,:digest,:scope,:profile,:payload,'draft',0,"
                ":created,:updated)"
            ),
            {
                "id": plan_id,
                "project": project_id,
                "snapshot": plan.snapshot_digest,
                "target": target_revision,
                "digest": plan_digest,
                "scope": scope_digest,
                "profile": plan.profile,
                "payload": payload,
                "created": timestamp,
                "updated": timestamp,
            },
        )
    return {
        "id": plan_id,
        "project_id": project_id,
        "plan_digest": plan_digest,
        "scope_digest": scope_digest,
        "target_revision": target_revision,
        "state": "draft",
        "revision": 0,
        "created_at": timestamp,
        "updated_at": timestamp,
        "payload": plan.model_dump(),
    }, True


def get_plan(engine: Engine, project_id: str, plan_id: str) -> dict[str, Any] | None:
    with engine.connect() as connection:
        row = (
            connection.execute(
                text("SELECT * FROM plans WHERE id=:id AND project_id=:project"),
                {"id": plan_id, "project": project_id},
            )
            .mappings()
            .first()
        )
    if not row:
        return None
    result = dict(row)
    result["payload"] = json.loads(result["payload"])
    return result


def validate_plan_row(plan: Mapping[str, Any], project_id: str) -> PlanSpec:
    """Validate the stored plan payload and every immutable digest column."""

    try:
        payload = plan["payload"]
        if isinstance(payload, str):
            payload = json.loads(payload)
        validated = PlanSpec.model_validate(payload)
    except (KeyError, TypeError, ValueError):
        raise RunConflict("plan_prerequisite_failed") from None
    if (
        plan.get("plan_digest") != validated.digest(project_id)
        or plan.get("scope_digest") != validated.scope_digest(project_id)
        or plan.get("target_revision") != validated.target.digest()
        or plan.get("snapshot_digest") != validated.snapshot_digest
        or plan.get("profile") != validated.profile
    ):
        raise RunConflict("plan_changed")
    if not validated.target.allowed_ips:
        raise RunConflict("target_address_binding_required")
    return validated


def create_active_run(
    engine: Engine,
    project_id: str,
    plan_id: str,
    approval_id: str,
    request_key: str,
) -> tuple[str, bool]:
    if not request_key or len(request_key) > 128:
        raise ValueError("invalid_idempotency_key")
    timestamp = now()
    with engine.begin() as connection:
        plan = (
            connection.execute(
                text("SELECT * FROM plans WHERE id=:id AND project_id=:project"),
                {"id": plan_id, "project": project_id},
            )
            .mappings()
            .first()
        )
        if not plan:
            raise RunConflict("plan_not_found")
        request_digest = digest([plan["plan_digest"], approval_id])
        previous = connection.execute(
            text(
                "SELECT id,request_digest FROM runs WHERE project_id=:project AND request_key=:key"
            ),
            {"project": project_id, "key": request_key},
        ).first()
        if previous:
            if previous[1] != request_digest:
                raise RunConflict("idempotency_conflict")
            return previous[0], False
        pending = connection.execute(
            text(
                "SELECT COUNT(*) FROM runs WHERE project_id=:project "
                "AND state IN ('queued','running')"
            ),
            {"project": project_id},
        ).scalar_one()
        if pending >= 2:
            raise RunConflict("queue_capacity")
        if plan["state"] != "approved":
            raise RunConflict("plan_not_approved")
        validated_plan = validate_plan_row(dict(plan), project_id)
        # No target-side limit or trusted cost telemetry adapter is available in
        # this runner yet. Keep strict mode fail-closed at the last control-plane
        # boundary so approval cannot turn it into an outbound run.
        if validated_plan.budget.cost_guard == "strict":
            raise RunConflict("strict_cost_guard_requires_target_control")
        consume_approval(
            connection,
            project_id,
            plan_id,
            approval_id,
            expected_plan_digest=plan["plan_digest"],
            expected_scope_digest=plan["scope_digest"],
        )
        run_id = str(uuid.uuid4())
        connection.execute(
            text(
                "INSERT INTO runs "
                "(id,project_id,state,profile,fixture,config_hash,request_key,request_digest,"
                "plan_id,approval_id,cancel_requested,attempts,created_at,updated_at,revision) "
                "VALUES (:id,:project,'queued','active',0,:config,:key,:request,:plan,"
                ":approval,0,0,:created,:updated,0)"
            ),
            {
                "id": run_id,
                "project": project_id,
                "config": plan["plan_digest"],
                "key": request_key,
                "request": request_digest,
                "plan": plan_id,
                "approval": approval_id,
                "created": timestamp,
                "updated": timestamp,
            },
        )
        connection.execute(
            text(
                "INSERT INTO run_events (run_id,sequence,state,created_at) "
                "VALUES (:id,0,'queued',:created)"
            ),
            {"id": run_id, "created": timestamp},
        )
    return run_id, True


def approve_plan(
    engine: Engine,
    project_id: str,
    plan_id: str,
    actor: str,
    acknowledgment: str,
    ttl_minutes: int,
) -> dict[str, Any]:
    if acknowledgment != "I_AUTHORIZE_THIS_EXPLICIT_SCOPE":
        raise ValueError("authorization_acknowledgment_required")
    if not actor or len(actor) > 128 or ttl_minutes < 1 or ttl_minutes > 30:
        raise ValueError("invalid_approval")
    safe_actor = str(redact(actor))[:128]
    with engine.begin() as connection:
        plan = (
            connection.execute(
                text("SELECT * FROM plans WHERE id=:id AND project_id=:project"),
                {"id": plan_id, "project": project_id},
            )
            .mappings()
            .first()
        )
        if not plan:
            raise RunConflict("plan_not_found")
        if plan["state"] != "draft":
            raise RunConflict("plan_not_approvable")
        validate_plan_row(dict(plan), project_id)
        approval_id = str(uuid.uuid4())
        expires_at = _expires(ttl_minutes)
        created_at = now()
        connection.execute(
            text(
                "INSERT INTO approvals "
                "(id,plan_id,project_id,plan_digest,scope_digest,actor,expires_at,created_at) "
                "VALUES (:id,:plan,:project,:digest,:scope,:actor,:expires,:created)"
            ),
            {
                "id": approval_id,
                "plan": plan_id,
                "project": project_id,
                "digest": plan["plan_digest"],
                "scope": plan["scope_digest"],
                "actor": safe_actor,
                "expires": expires_at,
                "created": created_at,
            },
        )
        connection.execute(
            text(
                "UPDATE plans SET state='approved', revision=revision+1, updated_at=:updated "
                "WHERE id=:id AND project_id=:project AND state='draft'"
            ),
            {"updated": created_at, "id": plan_id, "project": project_id},
        )
    return {
        "id": approval_id,
        "plan_id": plan_id,
        "project_id": project_id,
        "plan_digest": plan["plan_digest"],
        "scope_digest": plan["scope_digest"],
        "actor": safe_actor,
        "expires_at": expires_at,
        "consumed_at": None,
        "revoked_at": None,
    }


def consume_approval(
    connection: Connection,
    project_id: str,
    plan_id: str,
    approval_id: str,
    *,
    expected_plan_digest: str | None = None,
    expected_scope_digest: str | None = None,
) -> dict[str, Any]:
    current = datetime.now(UTC).isoformat()
    approval = (
        connection.execute(
            text(
                "SELECT * FROM approvals WHERE id=:approval AND plan_id=:plan "
                "AND project_id=:project"
            ),
            {"approval": approval_id, "plan": plan_id, "project": project_id},
        )
        .mappings()
        .first()
    )
    if not approval:
        raise RunConflict("approval_not_found")
    if (expected_plan_digest is not None and approval["plan_digest"] != expected_plan_digest) or (
        expected_scope_digest is not None and approval["scope_digest"] != expected_scope_digest
    ):
        raise RunConflict("plan_changed")
    if approval["consumed_at"] or approval["revoked_at"] or approval["expires_at"] <= current:
        raise RunConflict("approval_expired_or_used")
    updated = connection.execute(
        text(
            "UPDATE approvals SET consumed_at=:consumed WHERE id=:id "
            "AND consumed_at IS NULL AND revoked_at IS NULL"
        ),
        {"consumed": current, "id": approval_id},
    )
    if updated.rowcount != 1:
        raise RunConflict("approval_expired_or_used")
    connection.execute(
        text(
            "UPDATE plans SET state='consumed', revision=revision+1, updated_at=:updated "
            "WHERE id=:id AND project_id=:project AND state='approved'"
        ),
        {"updated": current, "id": plan_id, "project": project_id},
    )
    return cast(dict[str, Any], redact(dict(approval) | {"consumed_at": current}))


def revoke_plan(engine: Engine, project_id: str, plan_id: str) -> bool:
    with engine.begin() as connection:
        changed = connection.execute(
            text(
                "UPDATE plans SET state='revoked', revision=revision+1, updated_at=:updated "
                "WHERE id=:id AND project_id=:project AND state IN ('draft','approved')"
            ),
            {"updated": now(), "id": plan_id, "project": project_id},
        )
        connection.execute(
            text(
                "UPDATE approvals SET revoked_at=:revoked WHERE plan_id=:plan "
                "AND project_id=:project AND consumed_at IS NULL AND revoked_at IS NULL"
            ),
            {"revoked": now(), "plan": plan_id, "project": project_id},
        )
    return changed.rowcount == 1
