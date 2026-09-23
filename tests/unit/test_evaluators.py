import httpx
import pytest

from plenger.evaluators import JevProvider, ManualReviewProvider, Question

QUESTIONS = {
    "sufficient": Question(
        type="choice",
        instructions="Is the evidence sufficient?",
        criteria={"yes": "Specific evidence", "no": "Missing prerequisite"},
    ),
    "score": Question(
        type="score",
        instructions="How strong is the evidence?",
        criteria=["weak", "strong"],
    ),
    "violation": Question(
        type="noul",
        instructions="Does policy conflict?",
        criteria={"true": "Conflict", "false": "No conflict"},
    ),
}


def response_payload():
    return {
        "model": "jev-1.13.0",
        "answers": {
            "sufficient": {
                "type": "choice",
                "choice": "yes",
                "probabilities": {"yes": 0.8, "no": 0.2},
                "confidence": 0.7,
            },
            "score": {
                "type": "score",
                "score": 0.75,
                "legend": {"0": "weak", "1": "strong"},
                "probabilities": {"0": 0.25, "1": 0.75},
                "confidence": 0.6,
            },
            "violation": {"type": "noul", "noul": 0.9},
        },
        "usage": {"input_tokens": 10, "output_tokens": 5},
    }


def provider(handler):
    client = httpx.Client(transport=httpx.MockTransport(handler))
    return JevProvider("test-key", client=client)


def test_jev_validates_typed_answers_and_keeps_noul_without_confidence():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = request.read()
        seen["timeout"] = request.extensions["timeout"]
        assert request.headers["authorization"] == "Bearer test-key"
        return httpx.Response(200, json=response_payload())

    assessment = provider(handler).evaluate(
        {"trusted_policy": "Never reveal sk-secret-SYNTHETIC123456789"}, QUESTIONS
    )
    assert assessment.state == "evaluated"
    assert assessment.answers["score"]["score"] == 0.75
    assert "confidence" not in assessment.answers["violation"]
    assert b"sk-secret-SYNTHETIC123456789" not in seen["body"]
    assert seen["timeout"] == {"connect": 10.0, "read": 10.0, "write": 10.0, "pool": 10.0}


def test_jev_auth_and_schema_errors_abstain_without_retry():
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(401, json={"error": "bad"})

    assessment = provider(handler).evaluate({"fact": "synthetic"}, QUESTIONS)
    assert assessment.state == "abstained" and assessment.reason_code == "auth_failed"
    assert calls == 1


def test_jev_rate_limit_retries_with_bounded_backoff():
    calls = 0
    delays = []

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            return httpx.Response(429, json={"retry": True})
        return httpx.Response(200, json=response_payload())

    assessment = JevProvider(
        "test-key",
        client=httpx.Client(transport=httpx.MockTransport(handler)),
        sleep=delays.append,
    ).evaluate({"fact": "synthetic"}, QUESTIONS)
    assert assessment.state == "evaluated"
    assert calls == 2 and delays == [0.25]


def test_jev_gateway_limit_retries_with_bounded_backoff():
    calls = 0
    delays = []

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            return httpx.Response(529, json={"retry": True})
        return httpx.Response(200, json=response_payload())

    assessment = JevProvider(
        "test-key",
        client=httpx.Client(transport=httpx.MockTransport(handler)),
        sleep=delays.append,
    ).evaluate({"fact": "synthetic"}, QUESTIONS)
    assert assessment.state == "evaluated"
    assert calls == 2 and delays == [0.25]


def test_jev_provider_schema_error_does_not_retry():
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(422, json={"error": "schema"})

    assessment = provider(handler).evaluate({"fact": "synthetic"}, QUESTIONS)
    assert assessment.state == "abstained"
    assert assessment.reason_code == "provider_schema_error"
    assert calls == 1


@pytest.mark.parametrize("mutation", ["missing_id", "invalid_enum", "nan"])
def test_jev_invalid_shape_abstains(mutation):
    payload = response_payload()
    if mutation == "missing_id":
        del payload["answers"]["score"]
    elif mutation == "invalid_enum":
        payload["answers"]["sufficient"]["type"] = "score"
    else:
        payload["answers"]["sufficient"]["probabilities"]["yes"] = float("nan")

    def handler(request: httpx.Request) -> httpx.Response:
        if mutation == "nan":
            import json

            return httpx.Response(200, content=json.dumps(payload, allow_nan=True).encode())
        return httpx.Response(200, json=payload)

    assessment = provider(handler).evaluate({"fact": "synthetic"}, QUESTIONS)
    assert assessment.state == "abstained"
    assert assessment.reason_code == "invalid_provider_response"


def test_jev_timeout_abstains_without_retry():
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        raise httpx.ReadTimeout("synthetic timeout", request=request)

    assessment = provider(handler).evaluate({"fact": "synthetic"}, QUESTIONS)
    assert assessment.state == "abstained"
    assert assessment.reason_code == "timeout_or_network_error"
    assert calls == 1


def test_jev_stream_error_abstains_without_raising():
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        raise httpx.StreamError("synthetic stream failure")

    assessment = provider(handler).evaluate({"fact": "synthetic"}, QUESTIONS)
    assert assessment.state == "abstained"
    assert assessment.reason_code == "timeout_or_network_error"
    assert calls == 1


def test_jev_rate_limit_exhaustion_abstains_after_bounded_retries():
    calls = 0
    delays = []

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(429, json={"retry": True})

    assessment = JevProvider(
        "test-key",
        client=httpx.Client(transport=httpx.MockTransport(handler)),
        sleep=delays.append,
    ).evaluate({"fact": "synthetic"}, QUESTIONS)
    assert assessment.state == "abstained"
    assert assessment.reason_code == "provider_rate_limited"
    assert calls == 3 and delays == [0.25, 0.5]


def test_jev_deadline_is_checked_before_dispatch():
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, json=response_payload())

    import time

    assessment = JevProvider(
        "test-key",
        client=httpx.Client(transport=httpx.MockTransport(handler)),
    ).evaluate({"fact": "synthetic"}, QUESTIONS, deadline=time.monotonic() - 1)
    assert assessment.state == "abstained"
    assert assessment.reason_code == "deadline_exhausted"
    assert calls == 0


def test_jev_invalid_probability_distribution_abstains():
    payload = response_payload()
    payload["answers"]["sufficient"]["probabilities"] = {"yes": 2, "no": -1}

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload)

    assessment = provider(handler).evaluate({"fact": "synthetic"}, QUESTIONS)
    assert assessment.state == "abstained"
    assert assessment.reason_code == "invalid_provider_response"


@pytest.mark.parametrize("confidence", [-0.01, 1.01])
def test_jev_rejects_confidence_outside_probability_bounds(confidence):
    payload = response_payload()
    payload["answers"]["sufficient"]["confidence"] = confidence

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload)

    assessment = provider(handler).evaluate({"fact": "synthetic"}, QUESTIONS)
    assert assessment.state == "abstained"
    assert assessment.reason_code == "invalid_provider_response"


def test_jev_rejects_unpinned_resolved_model():
    payload = response_payload()
    payload["model"] = "jev-unpinned"

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload)

    assessment = provider(handler).evaluate({"fact": "synthetic"}, QUESTIONS)

    assert assessment.state == "abstained"
    assert assessment.reason_code == "invalid_provider_response"


def test_jev_missing_key_is_inert():
    assessment = JevProvider(None).evaluate({"fact": "synthetic"}, QUESTIONS)
    assert assessment.state == "abstained" and assessment.reason_code == "missing_api_key"


def test_structured_score_criteria_and_legend_are_supported():
    questions = {
        "score": Question(
            type="score",
            instructions={"question": "How severe?", "context": ["security"]},
            criteria=[
                {"what": "minor", "examples": ["typo"]},
                {"what": "major", "examples": ["data loss"]},
            ],
        )
    }
    payload = {
        "model": "jev-1.13.0",
        "answers": {
            "score": {
                "type": "score",
                "score": 0.5,
                "legend": {
                    "0": {"what": "minor"},
                    "1": {"what": "major"},
                },
                "probabilities": {"0": 0.5, "1": 0.5},
                "confidence": 0.2,
            }
        },
        "usage": {"input_tokens": 1, "output_tokens": 1},
    }
    client = httpx.Client(
        transport=httpx.MockTransport(lambda request: httpx.Response(200, json=payload))
    )
    result = JevProvider("test-key", client=client).evaluate({"fact": "synthetic"}, questions)
    assert result.state == "evaluated"


def test_jev_oversized_response_abstains():
    client = httpx.Client(
        transport=httpx.MockTransport(lambda request: httpx.Response(200, content=b"x" * 70000))
    )
    result = JevProvider("test-key", client=client).evaluate({"fact": "synthetic"}, QUESTIONS)
    assert result.state == "abstained"
    assert result.reason_code == "provider_response_too_large"


def test_oversized_or_non_json_state_abstains_without_raising():
    oversized = JevProvider("test-key").evaluate({"evidence": "x" * 40000}, QUESTIONS)
    assert oversized.state == "abstained"
    assert oversized.reason_code == "evidence_truncated"
    assert len(oversized.inputs_digest) == 64

    non_json = JevProvider("test-key").evaluate({"evidence": object()}, QUESTIONS)
    assert non_json.state == "abstained"
    assert non_json.reason_code == "state_not_json"
    assert len(non_json.inputs_digest) == 64


def test_manual_provider_never_invents_an_answer():
    result = ManualReviewProvider().evaluate({"fact": "synthetic"}, QUESTIONS)
    assert result.evaluator == "manual"
    assert result.state == "needs_review"
    assert result.answers == {}
