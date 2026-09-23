import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from plenger.broker import RequestBroker
from plenger.policy.active import BudgetSpec, PlanSpec, TargetSpec
from plenger.runner import (
    FIXED_CASES,
    FORBIDDEN_RESPONSE_MARKERS,
    FixtureObserver,
    run_fixed_cases,
)


class ModeHandler(BaseHTTPRequestHandler):
    mode = "fixed"
    observer: FixtureObserver | None = None

    def do_POST(self):  # noqa: N802
        size = int(self.headers.get("Content-Length", "0"))
        request = json.loads(self.rfile.read(size))
        case_id = request["test_context"]["case_id"]
        vulnerable = type(self).mode == "vulnerable"
        category = FIXED_CASES[case_id].category
        if category in FORBIDDEN_RESPONSE_MARKERS:
            output = (
                FORBIDDEN_RESPONSE_MARKERS[category]
                if vulnerable
                else "response safety boundary held"
            )
        else:
            output = "safe response"

        if case_id == "LLM01-direct-policy":
            trace = {
                "outcome": "policy_overridden" if vulnerable else "policy_held",
                "trace_id": "fixture-policy-" + type(self).mode,
            }
            if type(self).observer is not None:
                type(self).observer.record(case_id, trace)
        elif case_id == "LLM02-synthetic-disclosure":
            trace = {
                "outcome": "secret_disclosed" if vulnerable else "disclosure_prevented",
                "trace_id": "fixture-disclosure-" + type(self).mode,
            }
            if type(self).observer is not None:
                type(self).observer.record(case_id, trace)
        elif case_id == "LLM06-tool-authorization":
            trace = {
                "authorization_decision": "allow" if vulnerable else "deny",
                "outcome": "success" if vulnerable else "blocked",
                "trace_id": "fixture-tool-" + type(self).mode,
            }
            if type(self).observer is not None:
                type(self).observer.record(case_id, trace)
        elif case_id == "LLM08-tenant-boundary":
            trace = {
                "retrieved_doc_ids": ["tenant-b-doc-42"] if vulnerable else ["tenant-a-doc-1"],
                "trace_id": "fixture-retrieval-" + type(self).mode,
            }
            if type(self).observer is not None:
                type(self).observer.record(case_id, trace)
        else:
            trace = None

        body = {"output_text": output}
        if trace is not None:
            # The response copy is intentionally not the trusted observation.
            body["trace"] = {"observer_verified": True, **trace}
        encoded = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, format, *args):
        del format, args


class RecordingFixtureObserver(FixtureObserver):
    def __init__(self) -> None:
        super().__init__()
        self.attempts: dict[str, tuple[str, str, int]] = {}

    def begin_attempt(self, case_id: str, run_id: str, attempt_id: str, sequence: int) -> None:
        self.attempts[case_id] = (run_id, attempt_id, sequence)
        super().begin_attempt(case_id, run_id, attempt_id, sequence)


def _plan(port: int) -> PlanSpec:
    return PlanSpec(
        target=TargetSpec(
            target_ref="active-fixture",
            base_url=f"http://127.0.0.1:{port}",
            environment="local",
            allowed_paths=["/test"],
            allowed_methods=["POST"],
            observability="trace",
        ),
        case_ids=list(FIXED_CASES),
        snapshot_digest="a" * 64,
        auth_identity="fixture-user",
        budget=BudgetSpec(
            max_cases=10,
            max_attempts=10,
            cost_guard="request_only",
            cost_acknowledged=True,
        ),
    )


def test_vulnerable_and_fixed_target_families_have_distinct_results():
    server = ThreadingHTTPServer(("127.0.0.1", 0), ModeHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        for mode, expected in (("vulnerable", "fail"), ("fixed", "pass")):
            observer = RecordingFixtureObserver()
            ModeHandler.mode = mode
            ModeHandler.observer = observer
            plan = _plan(server.server_address[1])
            suite_run_id = "fixture-suite-" + mode
            results = run_fixed_cases(
                RequestBroker(plan.target, plan.budget), plan, observer, run_id=suite_run_id
            )
            assert [item["category"] for item in results] == [
                f"LLM{index:02d}" for index in range(1, 11)
            ]
            assert [item["result"] for item in results] == [expected] * 10
            observer_outcomes = {
                "LLM01-direct-policy": (
                    "policy_overridden" if mode == "vulnerable" else "policy_held"
                ),
                "LLM02-synthetic-disclosure": (
                    "secret_disclosed" if mode == "vulnerable" else "disclosure_prevented"
                ),
                "LLM06-tool-authorization": "success" if mode == "vulnerable" else "blocked",
                "LLM08-tenant-boundary": None,
            }
            for case_id, expected_outcome in observer_outcomes.items():
                observed_run_id, attempt_id, sequence = observer.attempts[case_id]
                assert observed_run_id == suite_run_id
                assert sequence == list(FIXED_CASES).index(case_id) + 1
                trace = observer.trace_for(case_id, run_id=observed_run_id, attempt_id=attempt_id)
                assert trace is not None
                assert trace["run_id"] == suite_run_id
                assert trace["attempt_id"] == attempt_id
                assert trace["sequence"] == sequence
                if expected_outcome is not None:
                    assert trace["outcome"] == expected_outcome
                assert (
                    observer.trace_for(case_id, run_id="wrong-run", attempt_id=attempt_id) is None
                )
                if case_id in {"LLM01-direct-policy", "LLM02-synthetic-disclosure"}:
                    assert any(
                        item.startswith("observer_trace_sha256:")
                        for item in results[sequence - 1]["evidence"]
                    )
    finally:
        ModeHandler.observer = None
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()


def test_vulnerable_synthetic_disclosure_marker_is_reported_as_failure():
    server = ThreadingHTTPServer(("127.0.0.1", 0), ModeHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    ModeHandler.mode = "vulnerable"
    ModeHandler.observer = None
    try:
        plan = _plan(server.server_address[1]).model_copy(
            update={"case_ids": ["LLM02-synthetic-disclosure"]}
        )
        result = run_fixed_cases(RequestBroker(plan.target, plan.budget), plan)[0]

        assert result["result"] == "fail"
        assert result["reason_code"] == "forbidden_marker_observed"
    finally:
        ModeHandler.mode = "fixed"
        ModeHandler.observer = None
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()
