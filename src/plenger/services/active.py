"""Project-bound plan, approval, and fixed-suite execution service."""

import json
import multiprocessing
import secrets
import tempfile
import threading
import time
from multiprocessing.connection import Connection
from multiprocessing.process import BaseProcess
from pathlib import Path
from typing import Any, Literal, cast

from sqlalchemy import text

from plenger.broker import (
    BrokerError,
    DispatchOutcome,
    RequestBroker,
    resolve_target_addresses,
)
from plenger.broker.ipc import (
    UnixBrokerEndpoint,
    UnixSocketRequestBroker,
    _run_unix_broker_process,
    active_runner_capability,
)
from plenger.domain import RunState
from plenger.policy import redact
from plenger.policy.active import BudgetSpec, PlanSpec, TargetSpec, preview
from plenger.runner import (
    FIXED_CASES,
    FixedCaseError,
    TrustedObserver,
    run_case,
    validate_case_ids,
)
from plenger.services.application import capabilities, project_id
from plenger.services.workspace import load_config
from plenger.storage import open_store
from plenger.storage.attempts import (
    finish_active_attempt,
    start_active_attempt,
)
from plenger.storage.locking import runtime_lock
from plenger.storage.plans import (
    approve_plan,
    create_active_run,
    create_plan,
    get_plan,
    revoke_plan,
    validate_plan_row,
)
from plenger.storage.runs import (
    RunConflict,
    advance,
    claim_lease,
    digest,
    get_run,
    heartbeat_lease,
    now,
    release_lease,
    request_cancel,
    update_attempts,
)


class _ActiveJobBroker(RequestBroker):
    """Route one active run through a child-process, capability-bound broker."""

    def __init__(self, target: TargetSpec, budget: BudgetSpec) -> None:
        super().__init__(target, budget)
        self._temporary_directory = tempfile.TemporaryDirectory(prefix="wkb-")
        socket_path = Path(self._temporary_directory.name) / "broker.sock"
        capability = secrets.token_urlsafe(32)
        self._process: BaseProcess | None = None
        self._closed = False
        self._transport_condition = threading.Condition()
        self._active_transport_calls = 0
        parent_ready: Connection | None = None
        child_ready: Connection | None = None
        try:
            context = multiprocessing.get_context("spawn")
            parent_ready, child_ready = context.Pipe(duplex=False)
            process_factory: Any = context.Process
            process = process_factory(
                target=_run_unix_broker_process,
                args=(str(socket_path), capability, target, budget, child_ready),
                name="plenger-active-broker",
                daemon=True,
            )
            self._process = process
            process.start()
            child_ready.close()
            if not parent_ready.poll(5.0):
                raise RuntimeError("broker_process_start_timeout")
            message = parent_ready.recv()
            if not isinstance(message, dict) or message.get("ok") is not True:
                raise RuntimeError("broker_process_start_failed")
            parent_ready.close()
            endpoint = UnixBrokerEndpoint(str(socket_path), capability)
            self._client = UnixSocketRequestBroker(endpoint, target, budget)
        except BaseException:
            if parent_ready is not None:
                parent_ready.close()
            if child_ready is not None:
                child_ready.close()
            self._stop_process()
            self._temporary_directory.cleanup()
            raise

    @property
    def worker_pid(self) -> int | None:
        return None if self._process is None else self._process.pid

    def dispatch(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
        deadline: float | None = None,
    ) -> DispatchOutcome:
        client = self._begin_transport_call()
        assert client is not None
        try:
            return client.dispatch(method, path, payload, deadline=deadline)
        finally:
            self._end_transport_call()

    def cancel(self) -> None:
        client = self._begin_transport_call(allow_closed=True)
        if client is None:
            return
        try:
            client.cancel()
        finally:
            self._end_transport_call()

    def stats(self) -> dict[str, Any]:
        client = self._begin_transport_call()
        assert client is not None
        try:
            return client.stats()
        finally:
            self._end_transport_call()

    def _begin_transport_call(
        self, *, allow_closed: bool = False
    ) -> UnixSocketRequestBroker | None:
        with self._transport_condition:
            if self._closed:
                if allow_closed:
                    return None
                raise BrokerError("broker_closed")
            self._active_transport_calls += 1
            return self._client

    def _end_transport_call(self) -> None:
        with self._transport_condition:
            self._active_transport_calls -= 1
            self._transport_condition.notify_all()

    def close(self) -> None:
        with self._transport_condition:
            if self._closed:
                return
            self._closed = True
            while self._active_transport_calls:
                self._transport_condition.wait()
        try:
            self._stop_process()
        finally:
            self._temporary_directory.cleanup()

    def _stop_process(self) -> None:
        process = self._process
        if process is None:
            return
        if process.pid is None:
            self._process = None
            return
        if process.is_alive():
            process.terminate()
        process.join(timeout=2)
        if process.is_alive():
            process.kill()
            process.join(timeout=2)
        self._process = None


_ACTIVE_RUNS: dict[str, _ActiveJobBroker] = {}
_ACTIVE_RUNS_LOCK = threading.Lock()


def plan_for_project(root: Path, plan: PlanSpec) -> dict[str, Any]:
    load_config(root)
    validate_case_ids(plan.case_ids)
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


def queue_active_run(
    root: Path, plan_id: str, approval_id: str, request_key: str
) -> tuple[str, bool]:
    load_config(root)
    if active_runner_capability().get("status") != "ready":
        raise RunConflict("active_runner_unavailable")
    engine = open_store(root)
    try:
        return create_active_run(engine, project_id(root), plan_id, approval_id, request_key)
    finally:
        engine.dispose()


def cancel_active_run(root: Path, run_id: str) -> str | None:
    load_config(root)
    engine = open_store(root)
    try:
        # Cancellation is the control plane for a worker that owns worker.lock;
        # it must remain able to write its intent while the data-plane worker is
        # dispatching. SQLite WAL keeps this short transaction independent of
        # the worker's OS lock.
        with engine.begin() as connection:
            state = request_cancel(connection, project_id(root), run_id)
        if state == RunState.CANCELLING.value:
            with _ACTIVE_RUNS_LOCK:
                broker = _ACTIVE_RUNS.get(run_id)
            if broker:
                try:
                    broker.cancel()
                except BrokerError:
                    # The database cancellation flag remains authoritative if
                    # the short-lived IPC call loses a race with worker cleanup.
                    pass
        return state
    finally:
        engine.dispose()


def _forget_observer_run(observer: TrustedObserver | None, run_id: str) -> None:
    if observer is None:
        return
    forget_run = getattr(observer, "forget_run", None)
    if not callable(forget_run):
        return
    try:
        forget_run(run_id)
    except Exception:
        # Observer cleanup is bounded auxiliary state; it must not replace the
        # finalized report or the runner's authoritative state transition.
        return


def execute_active_run(
    root: Path, run_id: str, observer: TrustedObserver | None = None
) -> dict[str, Any]:
    """Run the reviewed fixed suite through the bounded broker."""

    load_config(root)
    engine = open_store(root)
    identity = project_id(root)
    lease_owner = "active-" + run_id
    lease_claimed = False
    try:
        with runtime_lock(root):
            run = get_run(engine, identity, run_id)
            if run is None or run.get("profile") != "active":
                raise RunConflict("run_not_queued")
            if run["state"] == RunState.CANCELLING.value:
                with engine.begin() as connection:
                    advance(connection, identity, run_id, RunState.CANCELLED, "cancelled")
                return {"run_id": run_id, "project_id": identity, "state": "cancelled"}
            if run["state"] != RunState.QUEUED.value:
                raise RunConflict("run_not_queued")
            plan_row = get_plan(engine, identity, str(run["plan_id"]))
            if plan_row is None:
                with engine.begin() as connection:
                    advance(connection, identity, run_id, RunState.BLOCKED, "plan_not_found")
                raise RunConflict("plan_not_found")
            try:
                plan = validate_plan_row(plan_row, identity)
                if run["config_hash"] != plan_row["plan_digest"]:
                    raise RunConflict("plan_changed")
                validate_case_ids(plan.case_ids)
                if "POST" not in plan.target.allowed_methods:
                    raise FixedCaseError("fixed_suite_requires_post")
            except RunConflict as exc:
                reason = str(exc)
                with engine.begin() as connection:
                    advance(connection, identity, run_id, RunState.BLOCKED, reason)
                raise
            except (FixedCaseError, ValueError):
                with engine.begin() as connection:
                    advance(
                        connection, identity, run_id, RunState.BLOCKED, "plan_prerequisite_failed"
                    )
                raise RunConflict("plan_prerequisite_failed") from None
            try:
                broker = _ActiveJobBroker(plan.target, plan.budget)
            except (BrokerError, OSError, RuntimeError):
                with engine.begin() as connection:
                    advance(
                        connection,
                        identity,
                        run_id,
                        RunState.BLOCKED,
                        "active_runner_unavailable",
                    )
                raise
            try:
                with engine.begin() as connection:
                    status_row = connection.execute(
                        text(
                            "SELECT state,cancel_requested FROM runs "
                            "WHERE id=:id AND project_id=:project"
                        ),
                        {"id": run_id, "project": identity},
                    ).first()
                    if status_row is None:
                        raise RunConflict("run_not_found")
                    if status_row[0] == RunState.CANCELLING.value or status_row[1]:
                        advance(connection, identity, run_id, RunState.CANCELLED, "cancelled")
                        return {"run_id": run_id, "project_id": identity, "state": "cancelled"}
                    claim_lease(connection, identity, run_id, lease_owner, ttl_seconds=60)
                    lease_claimed = True
                    advance(connection, identity, run_id, RunState.RUNNING)
                deadline = time.monotonic() + plan.budget.wall_time_seconds
                with _ACTIVE_RUNS_LOCK:
                    _ACTIVE_RUNS[run_id] = broker
                try:
                    results: list[dict[str, Any]] = []
                    path = plan.target.allowed_paths[0]
                    timed_out = False
                    for case_id in plan.case_ids:
                        with engine.begin() as connection:
                            heartbeat_lease(
                                connection, identity, run_id, lease_owner, ttl_seconds=60
                            )
                        run_current = get_run(engine, identity, run_id)
                        if run_current is None or run_current.get("cancel_requested"):
                            broker.cancel()
                            break
                        if time.monotonic() >= deadline:
                            timed_out = True
                            broker.cancel()
                            attempt_index = len(results)
                            timeout_result = {
                                "case_id": case_id,
                                "category": FIXED_CASES[case_id].category,
                                "result": "error",
                                "reason_code": "wall_time_exhausted",
                                "evidence": [],
                            }
                            with engine.begin() as connection:
                                start_active_attempt(
                                    connection,
                                    identity,
                                    run_id,
                                    attempt_index,
                                    case_id,
                                    FIXED_CASES[case_id].category,
                                )
                                finish_active_attempt(
                                    connection, identity, run_id, attempt_index, timeout_result
                                )
                                update_attempts(
                                    connection,
                                    identity,
                                    run_id,
                                    broker.stats()["reserved_attempts"],
                                )
                            results.append(timeout_result)
                            break
                        attempt_index = len(results)
                        with engine.begin() as connection:
                            attempt_marker = start_active_attempt(
                                connection,
                                identity,
                                run_id,
                                attempt_index,
                                case_id,
                                FIXED_CASES[case_id].category,
                            )
                            update_attempts(connection, identity, run_id, attempt_index + 1)
                        case_result = run_case(
                            broker,
                            FIXED_CASES[case_id],
                            "POST",
                            path,
                            deadline=deadline,
                            observer=observer,
                            run_id=run_id,
                            attempt_id=str(attempt_marker["id"]),
                            attempt_sequence=attempt_index + 1,
                        )
                        results.append(case_result)
                        with engine.begin() as connection:
                            finish_active_attempt(
                                connection, identity, run_id, attempt_index, case_result
                            )
                            update_attempts(
                                connection, identity, run_id, broker.stats()["reserved_attempts"]
                            )
                        if case_result.get("reason_code") == "wall_time_exhausted":
                            timed_out = True
                            broker.cancel()
                            break
                    cancelled = broker.stats()["cancelled"] and not timed_out
                    if cancelled:
                        with engine.begin() as connection:
                            status_row = connection.execute(
                                text("SELECT state FROM runs WHERE id=:id AND project_id=:project"),
                                {"id": run_id, "project": identity},
                            ).first()
                            if status_row and status_row[0] == RunState.RUNNING.value:
                                advance(
                                    connection,
                                    identity,
                                    run_id,
                                    RunState.CANCELLING,
                                    "cancel_requested",
                                )
                            advance(connection, identity, run_id, RunState.CANCELLED, "cancelled")
                        state = RunState.CANCELLED.value
                    else:
                        state = (
                            RunState.COMPLETED_WITH_ERRORS.value
                            if timed_out or any(item["result"] == "error" for item in results)
                            else RunState.COMPLETED.value
                        )
                        with engine.begin() as connection:
                            final_row = connection.execute(
                                text(
                                    "SELECT state,cancel_requested FROM runs "
                                    "WHERE id=:id AND project_id=:project"
                                ),
                                {"id": run_id, "project": identity},
                            ).first()
                            if final_row and (
                                final_row[0] == RunState.CANCELLING.value or final_row[1]
                            ):
                                advance(
                                    connection,
                                    identity,
                                    run_id,
                                    RunState.CANCELLED,
                                    "cancelled",
                                )
                                cancelled = True
                                state = RunState.CANCELLED.value
                            else:
                                report_state = RunState(state)
                                report = _active_report(
                                    root, run, plan, results, broker.stats(), state, identity
                                )
                                connection.execute(
                                    text(
                                        "INSERT INTO reports (id,project_id,payload) "
                                        "VALUES (:id,:project,:payload)"
                                    ),
                                    {
                                        "id": run_id,
                                        "project": identity,
                                        "payload": json.dumps(redact(report), ensure_ascii=False),
                                    },
                                )
                                advance(connection, identity, run_id, report_state)
                                return report
                    report = _active_report(
                        root, run, plan, results, broker.stats(), state, identity
                    )
                    with engine.begin() as connection:
                        connection.execute(
                            text(
                                "INSERT INTO reports (id,project_id,payload) "
                                "VALUES (:id,:project,:payload)"
                            ),
                            {
                                "id": run_id,
                                "project": identity,
                                "payload": json.dumps(redact(report), ensure_ascii=False),
                            },
                        )
                    return report
                finally:
                    _forget_observer_run(observer, run_id)
                    with _ACTIVE_RUNS_LOCK:
                        _ACTIVE_RUNS.pop(run_id, None)
            finally:
                if lease_claimed:
                    with engine.begin() as connection:
                        release_lease(connection, identity, run_id, lease_owner)
                broker.close()
    except Exception:
        current = get_run(engine, identity, run_id)
        if current and current["state"] in {
            RunState.QUEUED.value,
            RunState.RUNNING.value,
            RunState.CANCELLING.value,
        }:
            if current["state"] == RunState.QUEUED.value:
                with engine.begin() as connection:
                    advance(
                        connection,
                        identity,
                        run_id,
                        RunState.BLOCKED,
                        "active_runner_failed",
                    )
            elif current["state"] == RunState.CANCELLING.value or current.get("cancel_requested"):
                with engine.begin() as connection:
                    if current["state"] == RunState.RUNNING.value:
                        advance(
                            connection,
                            identity,
                            run_id,
                            RunState.CANCELLING,
                            "cancel_requested",
                        )
                    advance(connection, identity, run_id, RunState.CANCELLED, "cancelled")
            else:
                with engine.begin() as connection:
                    advance(connection, identity, run_id, RunState.FAILED, "active_run_failed")
        raise
    finally:
        engine.dispose()


def _active_report(
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
    coverage = [
        {
            "category": f"LLM{index:02d}",
            "state": category_states.get(f"LLM{index:02d}", "planned"),
        }
        for index in range(1, 11)
    ]
    return {
        "schema_version": 1,
        "active": True,
        "fixture": True,
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
        "accounting": {
            "reserved_attempts": stats["reserved_attempts"],
            "cost": None,
            "cost_status": "unknown",
            "cost_guard": plan.budget.cost_guard,
        },
    }


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
    from plenger.policy.active import BudgetSpec

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


__all__ = [
    "RunConflict",
    "cancel_active_run",
    "digest",
    "execute_active_run",
    "get_project_plan",
    "approve_for_project",
    "plan_for_project",
    "plan_from_request",
    "queue_active_run",
    "revoke_project_plan",
]
