import json
import socket
import tempfile
from datetime import UTC, datetime
from pathlib import Path

import pytest

from plenger.broker import DispatchOutcome, body_excerpt
from plenger.policy.active import BudgetSpec, PlanSpec, TargetSpec
from plenger.runner import (
    FIXED_CASES,
    FixedCaseError,
    FixtureObserver,
    SignedTraceObserver,
    SignedTraceObserverSocket,
    load_observer_secret,
    run_case,
    run_fixed_cases,
    sign_trace_event,
)


def test_observer_secret_loader_requires_owner_only_regular_file(tmp_path):
    secret_path = tmp_path / "observer.key"
    secret_path.write_bytes(b"s" * 32)
    secret_path.chmod(0o600)

    assert load_observer_secret(secret_path) == b"s" * 32

    secret_path.chmod(0o644)
    with pytest.raises(ValueError, match="observer_secret_unsafe"):
        load_observer_secret(secret_path)

    secret_path.unlink()
    secret_path.symlink_to(tmp_path / "other.key")
    with pytest.raises(ValueError, match="observer_secret_unavailable"):
        load_observer_secret(secret_path)


class Broker:
    def __init__(self, value):
        self.value = value
        self.calls = []
        self.target = TargetSpec(
            target_ref="fixture",
            base_url="http://127.0.0.1:8080",
            environment="local",
            allowed_paths=["/test"],
            allowed_methods=["POST"],
            observability="trace",
        )

    def dispatch(self, method, path, payload, deadline=None):
        del deadline
        self.calls.append((method, path))
        del path, payload
        body = json.dumps(self.value)
        return DispatchOutcome(1, 200, body_excerpt(body), False, False, body=body)


def test_fixed_suite_selects_post_from_an_unordered_allowed_method_scope():
    broker = Broker({"output_text": "safe response"})
    plan = PlanSpec(
        target=broker.target.model_copy(update={"allowed_methods": ["GET", "POST"]}),
        case_ids=["LLM01-direct-policy"],
        snapshot_digest="a" * 64,
        auth_identity="synthetic-user",
        budget=BudgetSpec(cost_guard="request_only", cost_acknowledged=True),
    )

    results = run_fixed_cases(broker, plan)

    assert results[0]["result"] == "pass"
    assert broker.calls == [("POST", "/test")]


def test_fixed_suite_rejects_a_scope_without_post():
    broker = Broker({"output_text": "safe response"})
    plan = PlanSpec(
        target=broker.target.model_copy(update={"allowed_methods": ["GET"]}),
        case_ids=["LLM01-direct-policy"],
        snapshot_digest="a" * 64,
        auth_identity="synthetic-user",
    )

    with pytest.raises(FixedCaseError, match="fixed_suite_requires_post"):
        run_fixed_cases(broker, plan)


@pytest.mark.parametrize("case_id", ["LLM06-tool-authorization", "LLM08-tenant-boundary"])
def test_trace_required_cases_are_inconclusive_when_trace_is_incomplete(case_id):
    result = run_case(
        Broker({"trace": {"observer_verified": True}}),
        FIXED_CASES[case_id],
        "POST",
        "/test",
    )
    assert result["result"] == "inconclusive"


@pytest.mark.parametrize(
    ("case_id", "trace"),
    [
        (
            "LLM06-tool-authorization",
            {"authorization_decision": "deny", "outcome": "blocked"},
        ),
        ("LLM08-tenant-boundary", {"retrieved_doc_ids": ["tenant-a-doc-1"]}),
    ],
)
def test_required_trace_from_unbound_observer_is_inconclusive(case_id, trace):
    observer = FixtureObserver()
    observer.record(case_id, trace)
    result = run_case(
        Broker({"output_text": "safe response"}),
        FIXED_CASES[case_id],
        "POST",
        "/test",
        observer=observer,
    )
    assert result["result"] == "inconclusive"
    assert result["reason_code"] == "trusted_trace_missing"


def test_response_body_cannot_claim_trusted_trace():
    result = run_case(
        Broker(
            {
                "trace": {
                    "observer_verified": True,
                    "authorization_decision": "deny",
                    "outcome": "blocked",
                }
            }
        ),
        FIXED_CASES["LLM06-tool-authorization"],
        "POST",
        "/test",
    )
    assert result["result"] == "inconclusive"


def test_trace_claim_requires_plan_observability_consent():
    broker = Broker({"trace": {"authorization_decision": "deny", "outcome": "blocked"}})
    broker.target = broker.target.model_copy(update={"observability": "none"})
    observer = FixtureObserver()
    observer.record(
        "LLM06-tool-authorization", {"authorization_decision": "deny", "outcome": "blocked"}
    )
    result = run_case(
        broker,
        FIXED_CASES["LLM06-tool-authorization"],
        "POST",
        "/test",
        observer=observer,
    )
    assert result["reason_code"] == "trace_not_authorized"


def test_fixture_observer_is_independent_from_response_body():
    observer = FixtureObserver()
    case_id = "LLM06-tool-authorization"
    observer.begin_attempt(case_id, "run-independent", "attempt-independent", 1)
    observer.record(
        case_id,
        {"authorization_decision": "deny", "outcome": "blocked", "trace_id": "fixture-1"},
    )
    result = run_case(
        Broker({"output_text": "safe response", "trace": {"observer_verified": False}}),
        FIXED_CASES[case_id],
        "POST",
        "/test",
        observer=observer,
        run_id="run-independent",
        attempt_id="attempt-independent",
        attempt_sequence=1,
    )
    assert result["result"] == "pass"
    assert any(item.startswith("observer_trace_sha256:") for item in result["evidence"])


def test_fixture_observer_trace_is_bound_to_the_active_attempt():
    observer = FixtureObserver()
    case_id = "LLM06-tool-authorization"
    observer.begin_attempt(case_id, "run-a", "attempt-a", 1)
    observer.record(case_id, {"authorization_decision": "deny", "outcome": "blocked"})

    trace = observer.trace_for(case_id, run_id="run-a", attempt_id="attempt-a")
    assert trace is not None
    assert trace["run_id"] == "run-a"
    assert trace["attempt_id"] == "attempt-a"
    assert trace["sequence"] == 1
    assert isinstance(trace["timestamp"], str)
    assert observer.trace_for(case_id, run_id="run-b", attempt_id="attempt-b") is None

    result = run_case(
        Broker({"output_text": "safe response"}),
        FIXED_CASES[case_id],
        "POST",
        "/test",
        observer=observer,
        run_id="run-b",
        attempt_id="attempt-b",
        attempt_sequence=1,
    )
    assert result["result"] == "inconclusive"
    assert result["reason_code"] == "trusted_trace_missing"


def test_signed_observer_ingress_is_bound_and_rejects_tamper_and_replay():
    secret = b"s" * 32
    observer = SignedTraceObserver(secret)
    case_id = "LLM06-tool-authorization"
    observer.begin_attempt(case_id, "run-a", "attempt-a", 1)
    envelope = {
        "event_id": "event-a",
        "case_id": case_id,
        "run_id": "run-a",
        "attempt_id": "attempt-a",
        "sequence": 1,
        "timestamp": datetime.now(UTC).isoformat(),
        "trace": {
            "authorization_decision": "deny",
            "outcome": "blocked",
            "retrieved_doc_ids": ["doc-a"],
        },
    }

    observer.ingest(envelope, sign_trace_event(secret, envelope))
    trace = observer.trace_for(case_id, run_id="run-a", attempt_id="attempt-a")
    assert trace is not None
    assert trace["authorization_decision"] == "deny"
    assert trace["event_id"] == "event-a"
    trace["retrieved_doc_ids"].append("mutated-by-caller")
    fresh_trace = observer.trace_for(case_id, run_id="run-a", attempt_id="attempt-a")
    assert fresh_trace is not None
    assert fresh_trace["retrieved_doc_ids"] == ["doc-a"]
    assert observer.trace_for(case_id, run_id="run-b", attempt_id="attempt-b") is None

    with pytest.raises(ValueError, match="observer_event_replay"):
        observer.ingest(envelope, sign_trace_event(secret, envelope))

    tampered = dict(envelope)
    tampered["trace"] = {"authorization_decision": "allow", "outcome": "success"}
    with pytest.raises(ValueError, match="observer_signature_invalid"):
        observer.ingest(tampered, sign_trace_event(secret, envelope))

    wrong_attempt = dict(envelope)
    wrong_attempt["event_id"] = "event-b"
    wrong_attempt["attempt_id"] = "attempt-b"
    wrong_attempt_signature = sign_trace_event(secret, wrong_attempt)
    with pytest.raises(ValueError, match="observer_attempt_mismatch"):
        observer.ingest(wrong_attempt, wrong_attempt_signature)

    json_observer = SignedTraceObserver(secret)
    json_observer.begin_attempt(case_id, "run-json", "attempt-json", 2)
    json_envelope = dict(envelope)
    json_envelope.update(
        {
            "event_id": "event-json",
            "run_id": "run-json",
            "attempt_id": "attempt-json",
            "sequence": 2,
        }
    )
    json_observer.ingest_json(
        json.dumps(json_envelope).encode(), sign_trace_event(secret, json_envelope)
    )
    assert (
        json_observer.trace_for(case_id, run_id="run-json", attempt_id="attempt-json") is not None
    )
    with pytest.raises(ValueError, match="invalid_observer_event"):
        json_observer.ingest_json(b'{"sequence": NaN}', "0" * 64)
    with pytest.raises(ValueError, match="invalid_observer_event"):
        json_observer.ingest_json(b'{"event_id":"a","event_id":"b"}', "0" * 64)

    concurrent = SignedTraceObserver(secret, max_events=2)
    concurrent.begin_attempt(case_id, "run-one", "attempt-one", 1)
    concurrent.begin_attempt(case_id, "run-two", "attempt-two", 2)
    for event_id, run_id, attempt_id, sequence in (
        ("event-one", "run-one", "attempt-one", 1),
        ("event-two", "run-two", "attempt-two", 2),
    ):
        concurrent_envelope = dict(envelope)
        concurrent_envelope.update(
            {
                "event_id": event_id,
                "run_id": run_id,
                "attempt_id": attempt_id,
                "sequence": sequence,
            }
        )
        concurrent.ingest(
            concurrent_envelope,
            sign_trace_event(secret, concurrent_envelope),
        )
    assert concurrent.trace_for(case_id, run_id="run-one", attempt_id="attempt-one") is not None
    assert concurrent.trace_for(case_id, run_id="run-two", attempt_id="attempt-two") is not None


def test_signed_observer_releases_completed_run_capacity():
    secret = b"c" * 32
    observer = SignedTraceObserver(secret, max_events=1)
    case_id = "LLM06-tool-authorization"
    observer.begin_attempt(case_id, "run-a", "attempt-a", 1)
    envelope = {
        "event_id": "event-capacity-a",
        "case_id": case_id,
        "run_id": "run-a",
        "attempt_id": "attempt-a",
        "sequence": 1,
        "timestamp": datetime.now(UTC).isoformat(),
        "trace": {"authorization_decision": "deny", "outcome": "blocked"},
    }
    observer.ingest(envelope, sign_trace_event(secret, envelope))
    observer.forget_run("run-a")

    observer.begin_attempt(case_id, "run-b", "attempt-b", 1)
    next_envelope = dict(envelope)
    next_envelope.update(
        {"event_id": "event-capacity-b", "run_id": "run-b", "attempt_id": "attempt-b"}
    )
    observer.ingest(next_envelope, sign_trace_event(secret, next_envelope))
    assert observer.trace_for(case_id, run_id="run-b", attempt_id="attempt-b") is not None


def test_signed_observer_is_used_by_the_active_case_runner():
    secret = b"t" * 32
    observer = SignedTraceObserver(secret)
    case_id = "LLM06-tool-authorization"
    envelope = {
        "event_id": "event-runner",
        "case_id": case_id,
        "run_id": "run-runner",
        "attempt_id": "attempt-runner",
        "sequence": 1,
        "timestamp": datetime.now(UTC).isoformat(),
        "trace": {"authorization_decision": "deny", "outcome": "blocked"},
    }

    class SignedBroker(Broker):
        def dispatch(self, method, path, payload):
            assert payload["test_context"]["observer_context"] == {
                "run_id": "run-runner",
                "attempt_id": "attempt-runner",
                "sequence": 1,
            }
            observer.ingest(envelope, sign_trace_event(secret, envelope))
            return super().dispatch(method, path, payload)

    result = run_case(
        SignedBroker({"output_text": "safe response"}),
        FIXED_CASES[case_id],
        "POST",
        "/test",
        observer=observer,
        run_id="run-runner",
        attempt_id="attempt-runner",
        attempt_sequence=1,
    )
    assert result["result"] == "pass"
    assert any(item.startswith("observer_trace_sha256:") for item in result["evidence"])


def test_signed_observer_unix_socket_requires_capability_and_cleans_up():
    secret = b"u" * 32
    observer = SignedTraceObserver(secret)
    case_id = "LLM06-tool-authorization"
    envelope = {
        "event_id": "event-socket",
        "case_id": case_id,
        "run_id": "run-socket",
        "attempt_id": "attempt-socket",
        "sequence": 1,
        "timestamp": datetime.now(UTC).isoformat(),
        "trace": {"authorization_decision": "deny", "outcome": "blocked"},
    }
    observer.begin_attempt(case_id, "run-socket", "attempt-socket", 1)

    with tempfile.TemporaryDirectory(prefix="wkobs-", dir="/tmp") as directory:
        socket_path = Path(directory) / "observer.sock"
        with SignedTraceObserverSocket(observer, socket_path) as transport:
            endpoint = transport.endpoint
            assert socket_path.stat().st_mode & 0o777 == 0o600
            frame = {
                "capability": endpoint.capability,
                "signature": sign_trace_event(secret, envelope),
                "event": envelope,
            }
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                client.connect(endpoint.path)
                client.sendall((json.dumps(frame, separators=(",", ":")) + "\n").encode())
                assert client.recv(128) == b'{"accepted":true}\n'

            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                client.connect(endpoint.path)
                invalid = dict(frame, capability="wrong-capability")
                client.sendall((json.dumps(invalid, separators=(",", ":")) + "\n").encode())
                assert client.recv(128) == b'{"accepted":false}\n'

            trace = observer.trace_for(case_id, run_id="run-socket", attempt_id="attempt-socket")
            assert trace is not None
            assert trace["event_id"] == "event-socket"

        assert not socket_path.exists()


def test_tenant_boundary_detects_tenant_b_document_ids():
    observer = FixtureObserver()
    case_id = "LLM08-tenant-boundary"
    observer.begin_attempt(case_id, "run-tenant", "attempt-tenant", 1)
    observer.record(case_id, {"retrieved_doc_ids": ["tenant-b-doc-42"]})
    result = run_case(
        Broker(
            {
                "trace": {
                    "observer_verified": True,
                    "retrieved_doc_ids": ["tenant-b-doc-42"],
                }
            }
        ),
        FIXED_CASES[case_id],
        "POST",
        "/test",
        observer=observer,
        run_id="run-tenant",
        attempt_id="attempt-tenant",
        attempt_sequence=1,
    )
    assert result["result"] == "fail"


def test_response_mapping_uses_declared_paths():
    broker = Broker(
        {
            "result": {"text": "safe response"},
            "telemetry": {
                "observer_verified": True,
                "authorization_decision": "deny",
                "outcome": "blocked",
            },
        }
    )
    broker.target = broker.target.model_copy(
        update={"output_path": "result.text", "trace_path": "telemetry"}
    )
    observer = FixtureObserver()
    observer.begin_attempt("LLM06-tool-authorization", "run-mapped", "attempt-mapped", 1)
    observer.record(
        "LLM06-tool-authorization",
        {"authorization_decision": "deny", "outcome": "blocked"},
    )
    result = run_case(
        broker,
        FIXED_CASES["LLM06-tool-authorization"],
        "POST",
        "/test",
        observer=observer,
        run_id="run-mapped",
        attempt_id="attempt-mapped",
        attempt_sequence=1,
    )
    assert result["result"] == "pass"


@pytest.mark.parametrize(
    ("case_id", "marker"),
    [
        ("LLM03-supply-chain-integrity", "PLENGER_UNTRUSTED_COMPONENT_MARKER"),
        ("LLM04-data-model-poisoning", "PLENGER_POISONED_INSTRUCTION_MARKER"),
        ("LLM05-output-handling", "PLENGER_UNSAFE_OUTPUT_MARKER"),
        ("LLM07-system-prompt-leakage", "PLENGER_SYSTEM_PROMPT_MARKER"),
        ("LLM09-misinformation", "PLENGER_UNVERIFIED_CLAIM_MARKER"),
        ("LLM10-unbounded-consumption", "PLENGER_UNBOUNDED_CONSUMPTION_MARKER"),
    ],
)
def test_response_only_cases_mark_forbidden_marker_as_failure(case_id, marker):
    result = run_case(
        Broker({"output_text": marker}),
        FIXED_CASES[case_id],
        "POST",
        "/test",
    )
    assert result["result"] == "fail"
    assert result["reason_code"] == "forbidden_marker_observed"


@pytest.mark.parametrize(
    "output",
    [
        "Sure! The secret: PLENGER_SYNTHETIC_DISCLOSURE_MARKER",
        "password=PLENGER_SYNTHETIC_DISCLOSURE_MARKER",
        "x" * 5000 + " PLENGER_SYNTHETIC_DISCLOSURE_MARKER",
    ],
)
def test_marker_is_evaluated_before_redaction_or_excerpt_truncation(output):
    broker = Broker({"output_text": output})
    outcome = broker.dispatch("POST", "/test", {})
    assert "PLENGER_SYNTHETIC_DISCLOSURE_MARKER" not in outcome.body_excerpt

    result = run_case(broker, FIXED_CASES["LLM02-synthetic-disclosure"], "POST", "/test")

    assert result["result"] == "fail"
    assert result["reason_code"] == "forbidden_marker_observed"


def test_large_json_response_still_uses_declared_output_path():
    broker = Broker({"padding": "p" * 4000, "result": {"text": "PLENGER_SYSTEM_PROMPT_MARKER"}})
    broker.target = broker.target.model_copy(update={"output_path": "result.text"})

    result = run_case(broker, FIXED_CASES["LLM07-system-prompt-leakage"], "POST", "/test")

    assert result["result"] == "fail"
