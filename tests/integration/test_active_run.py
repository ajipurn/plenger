import json
import multiprocessing
import os
import socket
import tempfile
import threading
import time
import uuid
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from socket import AF_INET, SOCK_STREAM

import pytest

from plenger.broker import RequestBroker
from plenger.policy.active import BudgetSpec, PlanSpec, TargetSpec
from plenger.runner import (
    FIXED_CASES,
    FixtureObserver,
    SignedTraceObserver,
    SignedTraceObserverSocket,
    SignedTraceSocketEndpoint,
    run_fixed_cases,
    sign_trace_event,
)
from plenger.services.active import (
    _active_report,
    approve_for_project,
    cancel_active_run,
    execute_active_run,
    plan_for_project,
    queue_active_run,
)
from plenger.services.application import run_status
from plenger.services.workspace import initialize


class TargetHandler(BaseHTTPRequestHandler):
    observer: FixtureObserver | None = None

    def do_POST(self):  # noqa: N802
        size = int(self.headers.get("Content-Length", "0"))
        request = json.loads(self.rfile.read(size))
        case_id = request["test_context"]["case_id"]
        body = {"output_text": "safe response"}
        if case_id in {"LLM06-tool-authorization", "LLM08-tenant-boundary"}:
            trace = {
                "authorization_decision": "deny",
                "outcome": "blocked",
                "retrieved_doc_ids": ["tenant-a-doc"],
            }
            if type(self).observer is not None:
                type(self).observer.record(case_id, trace)
            # This field is intentionally untrusted; the runner must ignore it.
            body["trace"] = {"observer_verified": True, **trace}
        encoded = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, format, *args):
        del format, args


class SignedObserverTargetHandler(BaseHTTPRequestHandler):
    endpoint: SignedTraceSocketEndpoint | None = None
    secret: bytes | None = None

    def do_POST(self):  # noqa: N802
        size = int(self.headers.get("Content-Length", "0"))
        request = json.loads(self.rfile.read(size))
        context = request["test_context"]["observer_context"]
        endpoint = type(self).endpoint
        secret = type(self).secret
        assert endpoint is not None and secret is not None
        envelope = {
            "event_id": "sidecar-" + uuid.uuid4().hex,
            "case_id": request["test_context"]["case_id"],
            "run_id": context["run_id"],
            "attempt_id": context["attempt_id"],
            "sequence": context["sequence"],
            "timestamp": datetime.now(UTC).isoformat(),
            "trace": {"authorization_decision": "deny", "outcome": "blocked"},
        }
        frame = {
            "capability": endpoint.capability,
            "signature": sign_trace_event(secret, envelope),
            "event": envelope,
        }
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.connect(endpoint.path)
            client.sendall((json.dumps(frame, separators=(",", ":")) + "\n").encode())
            assert client.recv(128) == b'{"accepted":true}\n'
        encoded = json.dumps({"output_text": "safe response"}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, format, *args):
        del format, args


def test_local_fixed_suite_runs_only_after_approval(tmp_path):
    observer = FixtureObserver()
    TargetHandler.observer = observer
    server = ThreadingHTTPServer(("127.0.0.1", 0), TargetHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        initialize(tmp_path)
        port = server.server_address[1]
        plan = PlanSpec(
            target=TargetSpec(
                target_ref="fixture",
                base_url=f"http://127.0.0.1:{port}",
                environment="local",
                allowed_paths=["/test"],
                allowed_methods=["GET", "POST"],
                observability="trace",
            ),
            case_ids=["LLM01-direct-policy", "LLM06-tool-authorization"],
            snapshot_digest="a" * 64,
            auth_identity="synthetic-user",
            budget=BudgetSpec(cost_guard="request_only", cost_acknowledged=True),
        )
        created = plan_for_project(tmp_path, plan)
        approval = approve_for_project(
            tmp_path,
            created["id"],
            "local-user",
            "I_AUTHORIZE_THIS_EXPLICIT_SCOPE",
            5,
        )
        run_id, created_run = queue_active_run(
            tmp_path, created["id"], approval["id"], "active-integration"
        )
        assert created_run
        report = execute_active_run(tmp_path, run_id, observer=observer)
        assert report["state"] == "completed"
        assert report["accounting"] == {
            "reserved_attempts": 2,
            "cost": None,
            "cost_status": "unknown",
            "cost_guard": "request_only",
        }
        assert len(report["profile_digest"]) == 64
        assert report["case_count"] == 2
        assert [item["result"] for item in report["test_results"]] == ["pass", "pass"]
        coverage = {item["category"]: item["state"] for item in report["coverage"]}
        assert set(coverage) == {f"LLM{index:02d}" for index in range(1, 11)}
        assert coverage["LLM01"] == "executed"
        assert coverage["LLM06"] == "executed"
        assert coverage["LLM02"] == "planned"
        assert run_status(tmp_path, run_id)["state"] == "completed"
        from plenger.services.application import project_id
        from plenger.storage import open_store
        from plenger.storage.attempts import list_active_attempts

        engine = open_store(tmp_path)
        try:
            attempts = list_active_attempts(engine, project_id(tmp_path), run_id)
            assert len(attempts) == 2
            trace_attempt = next(
                item for item in attempts if item["case_id"] == "LLM06-tool-authorization"
            )
            trace = observer.trace_for(
                "LLM06-tool-authorization",
                run_id=run_id,
                attempt_id=trace_attempt["id"],
            )
            assert trace is not None
            assert trace["run_id"] == run_id
            assert trace["attempt_id"] == trace_attempt["id"]
            assert trace["sequence"] == 2
            assert (
                observer.trace_for(
                    "LLM06-tool-authorization",
                    run_id="wrong-run",
                    attempt_id=trace_attempt["id"],
                )
                is None
            )
        finally:
            engine.dispose()
        second_plan = plan.model_copy(update={"snapshot_digest": "b" * 64})
        second = plan_for_project(tmp_path, second_plan)
        second_approval = approve_for_project(
            tmp_path,
            second["id"],
            "local-user",
            "I_AUTHORIZE_THIS_EXPLICIT_SCOPE",
            5,
        )
        second_run, _ = queue_active_run(
            tmp_path, second["id"], second_approval["id"], "active-cancel"
        )
        assert cancel_active_run(tmp_path, second_run) == "cancelling"
        assert execute_active_run(tmp_path, second_run)["state"] == "cancelled"
        assert run_status(tmp_path, second_run)["state"] == "cancelled"
    finally:
        TargetHandler.observer = None
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()


def test_active_coverage_keeps_unexecuted_and_nonpass_states_distinct(tmp_path):
    initialize(tmp_path)
    selected_cases = [
        next(case_id for case_id, case in FIXED_CASES.items() if case.category == f"LLM{index:02d}")
        for index in range(1, 7)
    ]
    plan = PlanSpec(
        target=TargetSpec(
            target_ref="coverage-fixture",
            base_url="http://127.0.0.1:8080",
            environment="local",
            allowed_paths=["/test"],
            allowed_methods=["POST"],
            observability="trace",
        ),
        case_ids=selected_cases,
        snapshot_digest="a" * 64,
        auth_identity="synthetic-user",
        budget=BudgetSpec(cost_guard="request_only", cost_acknowledged=True),
    )
    results = [
        {
            "case_id": case_id,
            "category": FIXED_CASES[case_id].category,
            "result": result,
        }
        for case_id, result in zip(
            selected_cases,
            ("pass", "fail", "blocked", "skipped", "error", "inconclusive"),
            strict=True,
        )
    ]

    report = _active_report(
        tmp_path,
        {"id": "run-id", "plan_id": "plan-id", "approval_id": "approval-id"},
        plan,
        results,
        {"reserved_attempts": len(results)},
        "completed",
        "project-id",
    )

    states = {item["category"]: item["state"] for item in report["coverage"]}
    assert states == {
        "LLM01": "executed",
        "LLM02": "executed",
        "LLM03": "blocked",
        "LLM04": "skipped",
        "LLM05": "error",
        "LLM06": "inconclusive",
        "LLM07": "planned",
        "LLM08": "planned",
        "LLM09": "planned",
        "LLM10": "planned",
    }
    assert report["case_count"] == len(selected_cases)
    assert report["profile_digest"] == plan.profile_digest()
    assert report["limitations"] == [
        "Fixed local/staging suite only; no production target mode",
        "Pass/fail applies only to the selected fixed cases",
    ]


def test_active_run_accepts_run_bound_signed_sidecar_event(tmp_path):
    secret = b"z" * 32
    observer = SignedTraceObserver(secret)
    SignedObserverTargetHandler.endpoint = None
    SignedObserverTargetHandler.secret = secret
    server = ThreadingHTTPServer(("127.0.0.1", 0), SignedObserverTargetHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    observer_directory = tempfile.TemporaryDirectory(prefix="wko-", dir="/tmp")
    observer_socket = SignedTraceObserverSocket(
        observer, Path(observer_directory.name) / "observer.sock"
    )
    try:
        SignedObserverTargetHandler.endpoint = observer_socket.start()
        initialize(tmp_path)
        plan = PlanSpec(
            target=TargetSpec(
                target_ref="signed-fixture",
                base_url=f"http://127.0.0.1:{server.server_address[1]}",
                environment="local",
                allowed_paths=["/test"],
                allowed_methods=["POST"],
                observability="trace",
            ),
            case_ids=["LLM06-tool-authorization"],
            snapshot_digest="f" * 64,
            auth_identity="synthetic-user",
            budget=BudgetSpec(cost_guard="request_only", cost_acknowledged=True),
        )
        created = plan_for_project(tmp_path, plan)
        approval = approve_for_project(
            tmp_path,
            created["id"],
            "local-user",
            "I_AUTHORIZE_THIS_EXPLICIT_SCOPE",
            5,
        )
        run_id, _ = queue_active_run(tmp_path, created["id"], approval["id"], "signed-sidecar")
        report = execute_active_run(tmp_path, run_id, observer=observer)
        assert report["state"] == "completed"
        result = report["test_results"][0]
        assert result["result"] == "pass"
        assert "observer_verified_trace" in result["evidence"]
    finally:
        observer_socket.close()
        observer_directory.cleanup()
        SignedObserverTargetHandler.endpoint = None
        SignedObserverTargetHandler.secret = None
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()


def test_active_broker_start_failure_blocks_queued_run(tmp_path, monkeypatch):
    from plenger.services import active as active_service

    run_id = _queued_active_run(tmp_path, "active-broker-start-failure")

    def fail_start(*args, **kwargs):
        del args, kwargs
        raise RuntimeError("broker_process_start_failed")

    monkeypatch.setattr(active_service, "_ActiveJobBroker", fail_start)
    with pytest.raises(RuntimeError, match="broker_process_start_failed"):
        execute_active_run(tmp_path, run_id)

    status = run_status(tmp_path, run_id)
    assert status is not None
    assert status["state"] == "blocked"
    assert status["reason"] == "active_runner_unavailable"


def test_staging_fixed_suite_runs_through_pinned_https_contract(monkeypatch):
    class Response:
        status = 200

        def __init__(self):
            self.read_once = True

        def read(self, limit):
            del limit
            if not self.read_once:
                return b""
            self.read_once = False
            return b'{"output_text":"safe response"}'

    class Connection:
        def __init__(self, host, port, pinned_address, timeout):
            assert (host, port, pinned_address) == (
                "staging.example.test",
                443,
                "93.184.216.34",
            )
            del timeout

        def request(self, method, path, *, body, headers):
            assert method == "POST" and path == "/test"
            assert body is not None and headers["Host"] == "staging.example.test"

        def getresponse(self):
            return Response()

        def close(self):
            return None

    monkeypatch.setattr("plenger.broker._PinnedHTTPSConnection", Connection)
    monkeypatch.setattr(
        "plenger.broker.socket.getaddrinfo",
        lambda host, port, type: [(AF_INET, SOCK_STREAM, 6, "", ("93.184.216.34", port))],
    )
    plan = PlanSpec(
        target=TargetSpec(
            target_ref="staging-fixture",
            base_url="https://staging.example.test",
            environment="staging",
            allowed_paths=["/test"],
            allowed_methods=["POST"],
        ),
        case_ids=["LLM01-direct-policy"],
        snapshot_digest="e" * 64,
        auth_identity="synthetic-user",
        budget=BudgetSpec(cost_guard="request_only", cost_acknowledged=True),
    )
    result = run_fixed_cases(RequestBroker(plan.target, plan.budget), plan)
    assert result[0]["result"] == "pass"


class SlowTargetHandler(BaseHTTPRequestHandler):
    started = threading.Event()
    release = threading.Event()

    def do_POST(self):  # noqa: N802
        size = int(self.headers.get("Content-Length", "0"))
        self.rfile.read(size)
        type(self).started.set()
        type(self).release.wait(timeout=3)
        encoded = json.dumps({"output_text": "safe response"}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, format, *args):
        del format, args


def test_cancel_reaches_a_running_active_worker(tmp_path):
    from plenger.services import active as active_service

    SlowTargetHandler.started.clear()
    SlowTargetHandler.release.clear()
    server = ThreadingHTTPServer(("127.0.0.1", 0), SlowTargetHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    worker: threading.Thread | None = None
    try:
        initialize(tmp_path)
        port = server.server_address[1]
        plan = PlanSpec(
            target=TargetSpec(
                target_ref="slow-fixture",
                base_url=f"http://127.0.0.1:{port}",
                environment="local",
                allowed_paths=["/test"],
                allowed_methods=["POST"],
                observability="trace",
            ),
            case_ids=["LLM01-direct-policy"],
            snapshot_digest="c" * 64,
            auth_identity="synthetic-user",
            budget=BudgetSpec(cost_guard="request_only", cost_acknowledged=True),
        )
        created = plan_for_project(tmp_path, plan)
        approval = approve_for_project(
            tmp_path,
            created["id"],
            "local-user",
            "I_AUTHORIZE_THIS_EXPLICIT_SCOPE",
            5,
        )
        run_id, _ = queue_active_run(tmp_path, created["id"], approval["id"], "active-race")
        result: dict[str, dict] = {}

        def execute() -> None:
            result["report"] = execute_active_run(tmp_path, run_id)

        worker = threading.Thread(target=execute)
        worker.start()
        assert SlowTargetHandler.started.wait(timeout=3)
        with active_service._ACTIVE_RUNS_LOCK:
            active_broker = active_service._ACTIVE_RUNS.get(run_id)
        assert active_broker is not None
        assert active_broker.worker_pid is not None
        assert active_broker.worker_pid != os.getpid()
        assert cancel_active_run(tmp_path, run_id) == "cancelling"
        SlowTargetHandler.release.set()
        worker.join(timeout=5)
        assert not worker.is_alive()
        assert result["report"]["state"] == "cancelled"
        assert run_status(tmp_path, run_id)["state"] == "cancelled"
    finally:
        SlowTargetHandler.release.set()
        if worker is not None:
            worker.join(timeout=2)
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()


def test_cancelled_intent_wins_over_runner_exception(tmp_path, monkeypatch):
    from plenger.services import active as active_service

    run_id = _queued_active_run(tmp_path, "active-cancel-exception")

    def crash_after_cancel(*args, **kwargs):
        del args, kwargs
        assert cancel_active_run(tmp_path, run_id) == "cancelling"
        raise RuntimeError("runner_crash_after_cancel")

    monkeypatch.setattr(active_service, "run_case", crash_after_cancel)
    with pytest.raises(RuntimeError, match="runner_crash_after_cancel"):
        execute_active_run(tmp_path, run_id)

    status = run_status(tmp_path, run_id)
    assert status is not None
    assert status["state"] == "cancelled"
    assert status["reason"] == "cancelled"


def _queued_active_run(tmp_path, request_key: str) -> str:
    from plenger.services.workspace import initialize

    initialize(tmp_path)
    plan = PlanSpec(
        target=TargetSpec(
            target_ref="crash-fixture",
            base_url="http://127.0.0.1:8080",
            environment="local",
            allowed_paths=["/test"],
            allowed_methods=["POST"],
            observability="trace",
        ),
        case_ids=["LLM01-direct-policy"],
        snapshot_digest="d" * 64,
        auth_identity="synthetic-user",
        budget=BudgetSpec(cost_guard="request_only", cost_acknowledged=True),
    )
    created = plan_for_project(tmp_path, plan)
    approval = approve_for_project(
        tmp_path,
        created["id"],
        "local-user",
        "I_AUTHORIZE_THIS_EXPLICIT_SCOPE",
        5,
    )
    run_id, created_run = queue_active_run(tmp_path, created["id"], approval["id"], request_key)
    assert created_run
    return run_id


def _kill_active_child(root: str, run_id: str) -> None:
    from plenger.services import active as active_service

    def terminate_after_marker(*args, **kwargs):
        del args, kwargs
        with active_service._ACTIVE_RUNS_LOCK:
            broker = active_service._ACTIVE_RUNS[run_id]
            broker_directory = broker._temporary_directory.name
        (Path(root) / "broker-directory.txt").write_text(broker_directory)
        os._exit(17)

    active_service.run_case = terminate_after_marker
    active_service.execute_active_run(Path(root), run_id)


def test_recovery_marks_inflight_active_attempt_after_dispatch_crash(tmp_path, monkeypatch):
    from plenger.services import active as active_service
    from plenger.services import application
    from plenger.services.application import project_id, recover_runs
    from plenger.storage import open_store
    from plenger.storage.attempts import list_active_attempts

    run_id = _queued_active_run(tmp_path, "active-dispatch-crash")

    def crash_before_result(*args, **kwargs):
        del args, kwargs
        raise KeyboardInterrupt

    monkeypatch.setattr(active_service, "run_case", crash_before_result)
    with pytest.raises(KeyboardInterrupt):
        execute_active_run(tmp_path, run_id)

    engine = open_store(tmp_path)
    try:
        in_flight = list_active_attempts(engine, project_id(tmp_path), run_id)
        assert len(in_flight) == 1 and in_flight[0]["result"] == "in_flight"
    finally:
        engine.dispose()
    monkeypatch.setattr(application, "cleanup_run", lambda run: True)
    assert recover_runs(tmp_path) == 1
    assert run_status(tmp_path, run_id)["state"] == "interrupted"
    engine = open_store(tmp_path)
    try:
        interrupted = list_active_attempts(engine, project_id(tmp_path), run_id)
        assert interrupted[0]["result"] == "error"
        assert interrupted[0]["reason_code"] == "process_interrupted"
    finally:
        engine.dispose()


def test_wall_time_attempt_is_finished_before_run_exits(tmp_path, monkeypatch):
    from plenger.services import active as active_service
    from plenger.services.application import project_id
    from plenger.storage import open_store
    from plenger.storage.attempts import list_active_attempts

    run_id = _queued_active_run(tmp_path, "active-wall-time")

    def timed_out_case(*args, **kwargs):
        del args, kwargs
        return {
            "case_id": "LLM01-direct-policy",
            "category": "LLM01",
            "result": "error",
            "reason_code": "wall_time_exhausted",
            "evidence": [],
        }

    monkeypatch.setattr(active_service, "run_case", timed_out_case)
    report = execute_active_run(tmp_path, run_id)
    assert report["state"] == "completed_with_errors"
    engine = open_store(tmp_path)
    try:
        attempts = list_active_attempts(engine, project_id(tmp_path), run_id)
        assert len(attempts) == 1
        assert attempts[0]["result"] == "error"
        assert attempts[0]["reason_code"] == "wall_time_exhausted"
    finally:
        engine.dispose()


def test_recovery_keeps_completed_attempt_after_report_write_crash(tmp_path, monkeypatch):
    from plenger.services import active as active_service
    from plenger.services import application
    from plenger.services.application import project_id, recover_runs
    from plenger.storage import open_store
    from plenger.storage.attempts import list_active_attempts

    run_id = _queued_active_run(tmp_path, "active-report-crash")

    def completed_case(*args, **kwargs):
        del args, kwargs
        return {
            "case_id": "LLM01-direct-policy",
            "category": "LLM01",
            "result": "pass",
            "reason_code": "marker_not_observed",
            "evidence": ["response_observation"],
        }

    def crash_before_report(*args, **kwargs):
        del args, kwargs
        raise KeyboardInterrupt

    monkeypatch.setattr(active_service, "run_case", completed_case)
    monkeypatch.setattr(active_service, "_active_report", crash_before_report)
    with pytest.raises(KeyboardInterrupt):
        execute_active_run(tmp_path, run_id)

    engine = open_store(tmp_path)
    try:
        completed = list_active_attempts(engine, project_id(tmp_path), run_id)
        assert len(completed) == 1 and completed[0]["result"] == "pass"
    finally:
        engine.dispose()
    monkeypatch.setattr(application, "cleanup_run", lambda run: True)
    assert recover_runs(tmp_path) == 1
    assert run_status(tmp_path, run_id)["state"] == "interrupted"
    engine = open_store(tmp_path)
    try:
        recovered = list_active_attempts(engine, project_id(tmp_path), run_id)
        assert len(recovered) == 1 and recovered[0]["result"] == "pass"
    finally:
        engine.dispose()


@pytest.mark.skipif(
    "fork" not in multiprocessing.get_all_start_methods(),
    reason="process-crash test requires fork",
)
def test_recovery_marks_attempt_after_worker_process_is_killed(tmp_path, monkeypatch):
    from plenger.services import application
    from plenger.services.application import project_id, recover_runs
    from plenger.storage import open_store
    from plenger.storage.attempts import list_active_attempts

    run_id = _queued_active_run(tmp_path, "active-process-kill")
    context = multiprocessing.get_context("fork")
    process = context.Process(target=_kill_active_child, args=(str(tmp_path), run_id))
    process.start()
    process.join(timeout=10)
    assert not process.is_alive()
    assert process.exitcode == 17
    broker_directory = Path((tmp_path / "broker-directory.txt").read_text())
    deadline = time.monotonic() + 3
    while broker_directory.exists() and time.monotonic() < deadline:
        time.sleep(0.05)
    assert not broker_directory.exists()

    monkeypatch.setattr(application, "cleanup_run", lambda run: True)
    assert recover_runs(tmp_path) == 1
    assert run_status(tmp_path, run_id)["state"] == "interrupted"
    engine = open_store(tmp_path)
    try:
        attempts = list_active_attempts(engine, project_id(tmp_path), run_id)
        assert len(attempts) == 1
        assert attempts[0]["result"] == "error"
        assert attempts[0]["reason_code"] == "process_interrupted"
    finally:
        engine.dispose()
