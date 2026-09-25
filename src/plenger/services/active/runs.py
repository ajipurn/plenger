"""Queueing, cancellation and execution of approved fixed-suite runs."""

import json
import threading
import time
from pathlib import Path
from typing import Any

from sqlalchemy import text

from plenger.broker.dispatch import BrokerError
from plenger.broker.ipc import active_runner_capability
from plenger.domain.runs import RunState
from plenger.policy.redaction import redact
from plenger.runner.cases import FIXED_CASES, FixedCaseError, validate_case_ids
from plenger.runner.observer import TrustedObserver
from plenger.services.active.broker import ActiveJobBroker
from plenger.services.active.report import active_report
from plenger.services.active.worker import execute_confined_case
from plenger.services.application import project_id
from plenger.services.workspace import load_config
from plenger.storage.attempts import finish_active_attempt, start_active_attempt
from plenger.storage.database import open_store
from plenger.storage.locking import runtime_lock
from plenger.storage.plans import create_active_run, get_plan, validate_plan_row
from plenger.storage.runs import (
    RunConflict,
    advance,
    claim_lease,
    get_run,
    heartbeat_lease,
    release_lease,
    request_cancel,
    update_attempts,
)

_ACTIVE_RUNS: dict[str, ActiveJobBroker] = {}
_ACTIVE_RUNS_LOCK = threading.Lock()


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
                broker = ActiveJobBroker(plan.target, plan.budget)
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
                        run_current = get_run(engine, identity, run_id)
                        if (
                            run_current is None
                            or run_current.get("cancel_requested")
                            or run_current.get("state") == RunState.CANCELLING.value
                        ):
                            broker.cancel()
                            break
                        try:
                            with engine.begin() as connection:
                                heartbeat_lease(
                                    connection, identity, run_id, lease_owner, ttl_seconds=60
                                )
                        except RunConflict:
                            run_current = get_run(engine, identity, run_id)
                            if (
                                run_current is None
                                or run_current.get("cancel_requested")
                                or run_current.get("state") == RunState.CANCELLING.value
                            ):
                                broker.cancel()
                                break
                            raise
                        run_current = get_run(engine, identity, run_id)
                        if (
                            run_current is None
                            or run_current.get("cancel_requested")
                            or run_current.get("state") == RunState.CANCELLING.value
                        ):
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
                        case_result = execute_confined_case(
                            broker,
                            FIXED_CASES[case_id],
                            "POST",
                            path,
                            deadline=deadline,
                            observer=observer,
                            run_id=run_id,
                            attempt_id=str(attempt_marker["id"]),
                            attempt_sequence=attempt_index + 1,
                            cancelled=lambda: bool(
                                (current := get_run(engine, identity, run_id)) is None
                                or current.get("cancel_requested")
                            ),
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
                                report = active_report(
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
                    report = active_report(
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
