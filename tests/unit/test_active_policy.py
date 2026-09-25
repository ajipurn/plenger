import json
from concurrent.futures import ThreadPoolExecutor

import pytest
from pydantic import ValidationError
from sqlalchemy import text

from plenger.evaluators.rubric import ACTIVE_RUBRIC_HASH
from plenger.policy.active import BudgetSpec, PlanSpec, PolicyViolation, TargetSpec, dispatch_url
from plenger.services.active.plans import (
    approve_for_project,
    get_project_plan,
    plan_for_project,
    revoke_project_plan,
)
from plenger.services.active.runs import execute_active_run, queue_active_run
from plenger.services.application import run_status
from plenger.services.workspace import initialize
from plenger.storage.database import open_store
from plenger.storage.plans import consume_approval
from plenger.storage.runs import RunConflict


def target(**overrides):
    values = {
        "target_ref": "local-fixture",
        "base_url": "http://127.0.0.1:8080",
        "environment": "local",
        "allowed_paths": ["/health", "/v1/test"],
        "allowed_methods": ["POST"],
    }
    values.update(overrides)
    return TargetSpec(**values)


def plan():
    return PlanSpec(
        target=target(),
        case_ids=["LLM01-direct-policy"],
        snapshot_digest="a" * 64,
        auth_identity="synthetic-user-a",
        budget=BudgetSpec(cost_guard="request_only", cost_acknowledged=True),
    )


def test_target_policy_rejects_scope_expansion_and_unsafe_hosts():
    with pytest.raises(ValidationError):
        target(base_url="http://10.0.0.1:8080")
    with pytest.raises(ValidationError):
        target(allowed_paths=["/v1/../admin"])
    with pytest.raises(PolicyViolation):
        dispatch_url(target(), "GET", "/v1/test")
    assert dispatch_url(target(), "POST", "/v1/test") == "http://127.0.0.1:8080/v1/test"


def test_target_allowed_ip_set_is_validated_and_canonicalized():
    assert target(allowed_ips=["127.0.0.1"]).allowed_ips == ["127.0.0.1"]
    with pytest.raises(ValidationError, match="duplicate_allowed_ip"):
        target(allowed_ips=["127.0.0.1", "127.0.0.1"])
    with pytest.raises(ValidationError, match="allowed_ip_not_loopback"):
        target(allowed_ips=["10.0.0.1"])


@pytest.mark.parametrize(
    "address",
    [
        "127.0.0.1",
        "10.0.0.8",
        "169.254.169.254",
        "[::1]",
        "[fd00::1]",
        "[fe80::1]",
    ],
    ids=[
        "ipv4-loopback",
        "ipv4-private",
        "ipv4-metadata",
        "ipv6-loopback",
        "ipv6-private",
        "ipv6-link-local",
    ],
)
def test_staging_literal_private_and_loopback_addresses_are_rejected(address):
    with pytest.raises(ValidationError, match="unsafe_target_address"):
        target(
            base_url=f"https://{address}:8443",
            environment="staging",
        )


@pytest.mark.parametrize("hostname", ["*.staging.example.test", "staging.example.test."])
def test_staging_wildcard_and_absolute_hostnames_are_rejected(hostname):
    with pytest.raises(ValidationError, match="wildcard_or_absolute_target_host_forbidden"):
        target(base_url=f"https://{hostname}:8443", environment="staging")


def test_staging_target_rejects_zero_port():
    with pytest.raises(ValidationError, match="invalid_target_port"):
        target(
            base_url="https://staging.example.test:0",
            environment="staging",
        )


def test_plan_is_immutable_and_approval_is_one_use(tmp_path):
    initialize(tmp_path)
    created = plan_for_project(tmp_path, plan())
    repeat = plan_for_project(tmp_path, plan())
    assert created["id"] == repeat["id"]
    approval = approve_for_project(
        tmp_path,
        created["id"],
        "sk-approvalSYNTHETIC123456",
        "I_AUTHORIZE_THIS_EXPLICIT_SCOPE",
        30,
    )
    assert approval["plan_digest"] == created["plan_digest"]
    assert approval["actor"] == "[REDACTED]"
    engine = open_store(tmp_path)
    try:
        with engine.connect() as connection:
            stored_actor = connection.execute(
                text("SELECT actor FROM approvals WHERE id=:id"), {"id": approval["id"]}
            ).scalar_one()
    finally:
        engine.dispose()
    assert stored_actor == "[REDACTED]"
    assert created["preview"]["profile"] == "owasp-llm-2025-core"
    assert created["preview"]["allowed_ips"] == ["127.0.0.1"]
    assert len(created["preview"]["profile_digest"]) == 64
    assert (
        created["preview"]["profile_digest"]
        != plan().model_copy(update={"case_ids": ["LLM02-synthetic-disclosure"]}).profile_digest()
    )
    assert get_project_plan(tmp_path, created["id"])["state"] == "approved"


def test_draft_plan_without_approval_cannot_queue(tmp_path):
    initialize(tmp_path)
    created = plan_for_project(tmp_path, plan())

    with pytest.raises(RunConflict, match="plan_not_approved"):
        queue_active_run(tmp_path, created["id"], "missing-approval", "without-approval")

    assert get_project_plan(tmp_path, created["id"])["state"] == "draft"


def test_public_plan_payloads_are_redacted_and_duplicate_payload_is_decoded(tmp_path):
    initialize(tmp_path)
    requested = plan().model_copy(update={"auth_identity": "sk-planSYNTHETIC123456"})

    created = plan_for_project(tmp_path, requested)
    repeated = plan_for_project(tmp_path, requested)
    loaded = get_project_plan(tmp_path, created["id"])

    assert isinstance(repeated["payload"], dict)
    assert repeated["payload"]["auth_identity"] == "[REDACTED]"
    assert loaded and loaded["payload"]["auth_identity"] == "[REDACTED]"

    engine = open_store(tmp_path)
    try:
        with engine.connect() as connection:
            raw_payload = connection.execute(
                text("SELECT payload FROM plans WHERE id=:id"), {"id": created["id"]}
            ).scalar_one()
    finally:
        engine.dispose()
    assert "sk-planSYNTHETIC123456" in raw_payload


def test_consumed_approval_reader_redacts_tampered_actor(tmp_path):
    initialize(tmp_path)
    created = plan_for_project(tmp_path, plan())
    approval = approve_for_project(
        tmp_path,
        created["id"],
        "local-user",
        "I_AUTHORIZE_THIS_EXPLICIT_SCOPE",
        5,
    )
    engine = open_store(tmp_path)
    try:
        with engine.begin() as connection:
            connection.execute(
                text("UPDATE approvals SET actor=:actor WHERE id=:id"),
                {"actor": "sk-tampered-approval123456", "id": approval["id"]},
            )
            consumed = consume_approval(
                connection,
                created["project_id"],
                created["id"],
                approval["id"],
                expected_plan_digest=approval["plan_digest"],
                expected_scope_digest=approval["scope_digest"],
            )
    finally:
        engine.dispose()

    assert consumed["actor"] == "[REDACTED]"


def test_unbound_legacy_plan_cannot_be_approved(tmp_path):
    from plenger.services.application import project_id
    from plenger.storage.plans import create_plan

    initialize(tmp_path)
    engine = open_store(tmp_path)
    try:
        created, _ = create_plan(engine, project_id(tmp_path), plan())
    finally:
        engine.dispose()
    with pytest.raises(RunConflict, match="target_address_binding_required"):
        approve_for_project(
            tmp_path,
            created["id"],
            "local-user",
            "I_AUTHORIZE_THIS_EXPLICIT_SCOPE",
            5,
        )


def test_revoked_plan_digest_can_be_replanned(tmp_path):
    initialize(tmp_path)
    created = plan_for_project(tmp_path, plan())

    assert revoke_project_plan(tmp_path, created["id"])
    replacement = plan_for_project(tmp_path, plan())

    assert replacement["id"] != created["id"]
    approval = approve_for_project(
        tmp_path,
        replacement["id"],
        "local-user",
        "I_AUTHORIZE_THIS_EXPLICIT_SCOPE",
        30,
    )
    assert approval["plan_id"] == replacement["id"]


@pytest.mark.parametrize("closed_state", ["expired", "revoked"])
def test_expired_or_revoked_approval_cannot_queue(tmp_path, closed_state):
    initialize(tmp_path)
    created = plan_for_project(tmp_path, plan())
    approval = approve_for_project(
        tmp_path,
        created["id"],
        "local-user",
        "I_AUTHORIZE_THIS_EXPLICIT_SCOPE",
        5,
    )

    if closed_state == "expired":
        engine = open_store(tmp_path)
        try:
            with engine.begin() as connection:
                connection.execute(
                    text("UPDATE approvals SET expires_at=:expires WHERE id=:id"),
                    {"expires": "2000-01-01T00:00:00+00:00", "id": approval["id"]},
                )
        finally:
            engine.dispose()
        expected_conflict = "approval_expired_or_used"
        expected_plan_state = "approved"
    else:
        assert revoke_project_plan(tmp_path, created["id"])
        expected_conflict = "plan_not_approved"
        expected_plan_state = "revoked"

    with pytest.raises(RunConflict, match=expected_conflict):
        queue_active_run(tmp_path, created["id"], approval["id"], f"closed-{closed_state}")
    assert get_project_plan(tmp_path, created["id"])["state"] == expected_plan_state


def test_request_only_requires_explicit_cost_acknowledgment():
    with pytest.raises(ValidationError):
        BudgetSpec(cost_guard="request_only")
    assert (
        BudgetSpec(cost_guard="request_only", cost_acknowledged=True).cost_guard == "request_only"
    )


def test_strict_cost_guard_is_rejected_when_planning(tmp_path):
    initialize(tmp_path)
    strict = plan().model_copy(update={"budget": BudgetSpec()})
    with pytest.raises(ValueError, match="strict_cost_guard_requires_target_control"):
        plan_for_project(tmp_path, strict)


def test_stored_strict_plan_is_still_rejected_before_queueing(tmp_path):
    from plenger.services.application import project_id
    from plenger.storage.plans import create_plan

    initialize(tmp_path)
    strict = plan().model_copy(update={"budget": BudgetSpec()})
    strict = strict.model_copy(
        update={"target": strict.target.model_copy(update={"allowed_ips": ["127.0.0.1"]})}
    )
    engine = open_store(tmp_path)
    try:
        created, _ = create_plan(engine, project_id(tmp_path), strict)
    finally:
        engine.dispose()
    approval = approve_for_project(
        tmp_path,
        created["id"],
        "local-user",
        "I_AUTHORIZE_THIS_EXPLICIT_SCOPE",
        5,
    )
    with pytest.raises(RunConflict, match="strict_cost_guard_requires_target_control"):
        queue_active_run(tmp_path, created["id"], approval["id"], "strict-cost")
    assert get_project_plan(tmp_path, created["id"])["state"] == "approved"


def test_expired_unused_approval_can_be_replaced(tmp_path):
    initialize(tmp_path)
    created = plan_for_project(tmp_path, plan())
    first = approve_for_project(
        tmp_path, created["id"], "local-user", "I_AUTHORIZE_THIS_EXPLICIT_SCOPE", 5
    )
    with pytest.raises(RunConflict, match="plan_already_approved"):
        approve_for_project(
            tmp_path, created["id"], "local-user", "I_AUTHORIZE_THIS_EXPLICIT_SCOPE", 5
        )
    engine = open_store(tmp_path)
    try:
        with engine.begin() as connection:
            connection.execute(
                text("UPDATE approvals SET expires_at=:past WHERE id=:id"),
                {"past": "2000-01-01T00:00:00+00:00", "id": first["id"]},
            )
    finally:
        engine.dispose()
    with pytest.raises(RunConflict, match="approval_expired_or_used"):
        queue_active_run(tmp_path, created["id"], first["id"], "expired-approval")

    second = approve_for_project(
        tmp_path, created["id"], "local-user", "I_AUTHORIZE_THIS_EXPLICIT_SCOPE", 5
    )

    assert second["id"] != first["id"]
    assert get_project_plan(tmp_path, created["id"])["state"] == "approved"


def test_unavailable_active_runner_rejects_before_consuming_approval(tmp_path, monkeypatch):
    from plenger.services.active import runs as active_service

    initialize(tmp_path)
    created = plan_for_project(tmp_path, plan())
    approval = approve_for_project(
        tmp_path,
        created["id"],
        "local-user",
        "I_AUTHORIZE_THIS_EXPLICIT_SCOPE",
        5,
    )
    monkeypatch.setattr(
        active_service,
        "active_runner_capability",
        lambda: {"status": "unavailable", "reason": "posix_unix_socket_required"},
    )

    with pytest.raises(RunConflict, match="active_runner_unavailable"):
        queue_active_run(tmp_path, created["id"], approval["id"], "unavailable-runner")

    current = get_project_plan(tmp_path, created["id"])
    assert current is not None and current["state"] == "approved"


def test_plan_case_count_cannot_exceed_attempt_or_case_budget():
    with pytest.raises(ValidationError, match="case_budget_exceeded"):
        PlanSpec(
            target=target(),
            case_ids=["LLM01-direct-policy", "LLM02-synthetic-disclosure"],
            snapshot_digest="a" * 64,
            auth_identity="synthetic-user-a",
            budget=BudgetSpec(max_cases=1, max_attempts=2),
        )
    with pytest.raises(ValidationError, match="attempt_budget_exceeded"):
        PlanSpec(
            target=target(),
            case_ids=["LLM01-direct-policy", "LLM02-synthetic-disclosure"],
            snapshot_digest="a" * 64,
            auth_identity="synthetic-user-a",
            budget=BudgetSpec(max_cases=2, max_attempts=1),
        )


def test_active_approval_is_consumed_once_under_parallel_queue_requests(tmp_path):
    from plenger.services.workspace import initialize

    initialize(tmp_path)
    created = plan_for_project(tmp_path, plan())
    approval = approve_for_project(
        tmp_path,
        created["id"],
        "local-user",
        "I_AUTHORIZE_THIS_EXPLICIT_SCOPE",
        5,
    )

    def submit(index):
        try:
            return queue_active_run(tmp_path, created["id"], approval["id"], f"parallel-{index}")
        except RunConflict as exc:
            return str(exc)

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(submit, range(8)))
    created_runs = [item for item in results if isinstance(item, tuple) and item[1]]
    conflicts = [item for item in results if isinstance(item, str)]
    assert len(created_runs) == 1
    assert len(conflicts) == 7
    assert set(conflicts) <= {"approval_expired_or_used", "plan_not_approved"}


def test_active_request_key_replays_and_rejects_a_different_approval(tmp_path):
    initialize(tmp_path)
    first = plan_for_project(tmp_path, plan())
    first_approval = approve_for_project(
        tmp_path,
        first["id"],
        "local-user",
        "I_AUTHORIZE_THIS_EXPLICIT_SCOPE",
        5,
    )
    run_id, created = queue_active_run(tmp_path, first["id"], first_approval["id"], "active-replay")
    replay_id, replayed = queue_active_run(
        tmp_path, first["id"], first_approval["id"], "active-replay"
    )
    assert (replay_id, replayed) == (run_id, False)

    second = plan_for_project(tmp_path, plan().model_copy(update={"snapshot_digest": "b" * 64}))
    second_approval = approve_for_project(
        tmp_path,
        second["id"],
        "local-user",
        "I_AUTHORIZE_THIS_EXPLICIT_SCOPE",
        5,
    )
    with pytest.raises(RunConflict, match="idempotency_conflict"):
        queue_active_run(tmp_path, second["id"], second_approval["id"], "active-replay")
    assert get_project_plan(tmp_path, second["id"])["state"] == "approved"
    assert created


def test_active_payload_mutation_invalidates_approval_before_queue(tmp_path):
    initialize(tmp_path)
    created = plan_for_project(tmp_path, plan())
    approval = approve_for_project(
        tmp_path,
        created["id"],
        "local-user",
        "I_AUTHORIZE_THIS_EXPLICIT_SCOPE",
        5,
    )
    engine = open_store(tmp_path)
    try:
        with engine.begin() as connection:
            payload = json.loads(
                connection.execute(
                    text("SELECT payload FROM plans WHERE id=:id"), {"id": created["id"]}
                ).scalar_one()
            )
            payload["auth_identity"] = "mutated-after-approval"
            connection.execute(
                text("UPDATE plans SET payload=:payload WHERE id=:id"),
                {"id": created["id"], "payload": json.dumps(payload, sort_keys=True)},
            )
    finally:
        engine.dispose()

    with pytest.raises(RunConflict, match="plan_changed"):
        queue_active_run(tmp_path, created["id"], approval["id"], "mutated-plan")
    assert get_project_plan(tmp_path, created["id"])["state"] == "approved"


@pytest.mark.parametrize(
    ("field_path", "value"),
    [
        ("target.base_url", "http://127.0.0.1:8081"),
        ("target.allowed_ips", ["127.0.0.2"]),
        ("profile", "unsupported-profile"),
        ("snapshot_digest", "b" * 64),
        ("auth_identity", "different-local-user"),
        ("budget.max_attempts", 79),
        ("data_classes", ["metadata"]),
        ("rubric_hash", "c" * 64),
        ("case_ids", ["LLM02-synthetic-disclosure"]),
    ],
)
def test_active_scope_mutation_invalidates_approval_before_queue(tmp_path, field_path, value):
    initialize(tmp_path)
    created = plan_for_project(tmp_path, plan())
    approval = approve_for_project(
        tmp_path,
        created["id"],
        "local-user",
        "I_AUTHORIZE_THIS_EXPLICIT_SCOPE",
        5,
    )
    engine = open_store(tmp_path)
    try:
        with engine.begin() as connection:
            payload = json.loads(
                connection.execute(
                    text("SELECT payload FROM plans WHERE id=:id"), {"id": created["id"]}
                ).scalar_one()
            )
            current = payload
            path_parts = field_path.split(".")
            for part in path_parts[:-1]:
                current = current[part]
            current[path_parts[-1]] = value
            connection.execute(
                text("UPDATE plans SET payload=:payload WHERE id=:id"),
                {"id": created["id"], "payload": json.dumps(payload, sort_keys=True)},
            )
    finally:
        engine.dispose()

    with pytest.raises(RunConflict):
        queue_active_run(tmp_path, created["id"], approval["id"], f"mutated-{field_path}")
    assert get_project_plan(tmp_path, created["id"])["state"] == "approved"


def test_plan_rubric_is_bound_into_digest_and_visible_in_preview(tmp_path):
    initialize(tmp_path)
    reviewed_plan = plan()
    assert reviewed_plan.rubric_hash == ACTIVE_RUBRIC_HASH
    changed_rubric = reviewed_plan.model_copy(update={"rubric_hash": "d" * 64})
    assert changed_rubric.digest("project") != reviewed_plan.digest("project")
    assert changed_rubric.scope_digest("project") != reviewed_plan.scope_digest("project")

    created = plan_for_project(tmp_path, reviewed_plan)
    preview = created["preview"]
    assert preview["project_id"] == created["project_id"]
    assert preview["rubric_hash"] == ACTIVE_RUBRIC_HASH
    assert preview["case_ids"] == reviewed_plan.case_ids
    assert preview["snapshot_digest"] == reviewed_plan.snapshot_digest
    assert preview["auth_identity"] == reviewed_plan.auth_identity
    assert preview["profile_digest"] == reviewed_plan.profile_digest()
    assert preview["scope_digest"] == created["scope_digest"]
    assert preview["base_origin"] == "http://127.0.0.1:8080"
    assert preview["allowed_ips"] == ["127.0.0.1"]
    assert preview["budget"] == reviewed_plan.budget.model_dump()


def test_active_payload_mutation_blocks_new_approval(tmp_path):
    initialize(tmp_path)
    created = plan_for_project(tmp_path, plan())
    engine = open_store(tmp_path)
    try:
        with engine.begin() as connection:
            payload = json.loads(
                connection.execute(
                    text("SELECT payload FROM plans WHERE id=:id"), {"id": created["id"]}
                ).scalar_one()
            )
            payload["auth_identity"] = "mutated-before-approval"
            connection.execute(
                text("UPDATE plans SET payload=:payload WHERE id=:id"),
                {"id": created["id"], "payload": json.dumps(payload, sort_keys=True)},
            )
    finally:
        engine.dispose()

    with pytest.raises(RunConflict, match="plan_changed"):
        approve_for_project(
            tmp_path,
            created["id"],
            "local-user",
            "I_AUTHORIZE_THIS_EXPLICIT_SCOPE",
            5,
        )
    assert get_project_plan(tmp_path, created["id"])["state"] == "draft"


def test_active_approval_digest_mutation_does_not_consume_approval(tmp_path):
    initialize(tmp_path)
    created = plan_for_project(tmp_path, plan())
    approval = approve_for_project(
        tmp_path,
        created["id"],
        "local-user",
        "I_AUTHORIZE_THIS_EXPLICIT_SCOPE",
        5,
    )
    engine = open_store(tmp_path)
    try:
        with engine.begin() as connection:
            connection.execute(
                text("UPDATE approvals SET scope_digest=:scope WHERE id=:id"),
                {"id": approval["id"], "scope": "f" * 64},
            )
    finally:
        engine.dispose()

    with pytest.raises(RunConflict, match="plan_changed"):
        queue_active_run(tmp_path, created["id"], approval["id"], "mutated-approval")
    assert get_project_plan(tmp_path, created["id"])["state"] == "approved"


def test_active_payload_mutation_after_queue_blocks_execution(tmp_path):
    initialize(tmp_path)
    created = plan_for_project(tmp_path, plan())
    approval = approve_for_project(
        tmp_path,
        created["id"],
        "local-user",
        "I_AUTHORIZE_THIS_EXPLICIT_SCOPE",
        5,
    )
    run_id, _created = queue_active_run(
        tmp_path, created["id"], approval["id"], "mutated-before-execution"
    )
    engine = open_store(tmp_path)
    try:
        with engine.begin() as connection:
            payload = json.loads(
                connection.execute(
                    text("SELECT payload FROM plans WHERE id=:id"), {"id": created["id"]}
                ).scalar_one()
            )
            payload["data_classes"] = ["prompt"]
            connection.execute(
                text("UPDATE plans SET payload=:payload WHERE id=:id"),
                {"id": created["id"], "payload": json.dumps(payload, sort_keys=True)},
            )
    finally:
        engine.dispose()

    with pytest.raises(RunConflict, match="plan_changed"):
        execute_active_run(tmp_path, run_id)
    assert run_status(tmp_path, run_id)["state"] == "blocked"
    with pytest.raises(ValidationError, match="attempt_budget_exceeded"):
        PlanSpec(
            target=target(),
            case_ids=["LLM01-direct-policy", "LLM02-synthetic-disclosure"],
            snapshot_digest="a" * 64,
            auth_identity="synthetic-user-a",
            budget=BudgetSpec(max_cases=2, max_attempts=1),
        )


@pytest.mark.parametrize(
    "base_url",
    ["https://[2002:a00:1::1]", "https://[64:ff9b:1::a00:1]", "https://100.64.0.1"],
)
def test_staging_literal_targets_reject_transition_and_shared_ranges(base_url):
    with pytest.raises(ValueError, match="unsafe_target_address"):
        TargetSpec(
            target_ref="staging-target",
            base_url=base_url,
            environment="staging",
            allowed_paths=["/test"],
            allowed_methods=["POST"],
        )


def test_database_allows_only_one_live_approval_per_plan(tmp_path):
    import sqlalchemy.exc

    initialize(tmp_path)
    created = plan_for_project(tmp_path, plan())
    approval = approve_for_project(
        tmp_path, created["id"], "local-user", "I_AUTHORIZE_THIS_EXPLICIT_SCOPE", 5
    )
    engine = open_store(tmp_path)
    try:
        with pytest.raises(sqlalchemy.exc.IntegrityError), engine.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO approvals (id,plan_id,project_id,plan_digest,scope_digest,"
                    "actor,expires_at,created_at) SELECT :id,plan_id,project_id,plan_digest,"
                    "scope_digest,actor,expires_at,created_at FROM approvals WHERE id=:source"
                ),
                {"id": "duplicate-live-approval-000000000000", "source": approval["id"]},
            )
    finally:
        engine.dispose()
