"""Assessment providers: deterministic, manual review, and the opt-in hosted Jev adapter.

Evaluators can describe evidence, but they never receive execution authority and
their output is never used to change finding severity or lifecycle automatically.
"""

from __future__ import annotations

import json
import math
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal

import httpx
from pydantic import FiniteFloat

from plenger.domain.digests import digest
from plenger.evaluators.models import (
    Assessment,
    AssessmentError,
    ChoiceAnswer,
    JevResponse,
    NoulAnswer,
    ScoreAnswer,
)
from plenger.evaluators.rubric import Question
from plenger.policy.redaction import redact

MAX_STATE_BYTES = 32 * 1024
MAX_RESPONSE_BYTES = 64 * 1024
REQUEST_TIMEOUT_SECONDS = 10.0
JEV_URL = "https://api.typesafe.ai/v1/systemone"
JEV_DEFAULT_MODEL = "jev-1.13.0"


def _bounded_request(
    state: dict[str, Any], model: str, questions: dict[str, Question]
) -> tuple[dict[str, Any], str, str]:
    try:
        redacted = redact(state)
        payload = {
            "state": redacted,
            "model": model,
            "questions": {
                key: question.model_dump(exclude_none=True) for key, question in questions.items()
            },
        }
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
    except (TypeError, ValueError, RecursionError):
        raise AssessmentError("state_not_json") from None
    if len(encoded) > MAX_STATE_BYTES:
        raise AssessmentError("evidence_truncated")
    rubric = {key: value.model_dump() for key, value in questions.items()}
    try:
        return payload, digest(payload), digest(rubric)
    except (TypeError, ValueError, RecursionError):
        raise AssessmentError("state_not_json") from None


def _fallback_digests(
    state: dict[str, Any], questions: dict[str, Question], reason_code: str
) -> tuple[str, str]:
    """Return safe digests when the original state cannot be serialized."""

    try:
        rubric_hash = digest({key: value.model_dump() for key, value in questions.items()})
    except (TypeError, ValueError, RecursionError):
        rubric_hash = digest({"question_ids": sorted(questions)})
    inputs_digest = digest(
        {
            "abstained": True,
            "reason_code": reason_code,
            "state_type": type(state).__name__,
        }
    )
    return inputs_digest, rubric_hash


def semantic_assessment_digests(
    state: dict[str, Any], model: str, questions: dict[str, Question]
) -> tuple[str, str]:
    """Return the input and rubric identities used by the semantic cache."""

    _payload, inputs_digest, rubric_hash = _bounded_request(state, model, questions)
    return inputs_digest, rubric_hash


def _validate_probability_map(probabilities: dict[str, FiniteFloat], allowed: set[str]) -> None:
    if set(probabilities) != allowed or any(
        value < 0 or value > 1 for value in probabilities.values()
    ):
        raise AssessmentError("invalid_probability_distribution")
    if not math.isclose(sum(probabilities.values()), 1.0, abs_tol=0.01):
        raise AssessmentError("invalid_probability_distribution")


def validate_answers(
    response: JevResponse, questions: dict[str, Question]
) -> dict[str, dict[str, Any]]:
    if set(response.answers) != set(questions):
        raise AssessmentError("question_answer_mismatch")
    answers: dict[str, dict[str, Any]] = {}
    for question_id, question in questions.items():
        raw = response.answers[question_id]
        if question.type == "choice":
            choice_answer = ChoiceAnswer.model_validate(raw)
            assert isinstance(question.criteria, dict)
            allowed = set(question.criteria)
            if choice_answer.choice not in allowed:
                raise AssessmentError("invalid_choice")
            _validate_probability_map(choice_answer.probabilities, allowed)
            answer_value = choice_answer.model_dump()
        elif question.type == "score":
            score_answer = ScoreAnswer.model_validate(raw)
            assert isinstance(question.criteria, list)
            allowed = {str(index) for index in range(len(question.criteria))}
            if set(score_answer.legend) != allowed:
                raise AssessmentError("invalid_score_legend")
            if score_answer.score < 0 or score_answer.score > len(question.criteria) - 1:
                raise AssessmentError("invalid_score")
            _validate_probability_map(score_answer.probabilities, allowed)
            answer_value = score_answer.model_dump()
        else:
            noul_answer = NoulAnswer.model_validate(raw)
            if noul_answer.noul < 0 or noul_answer.noul > 1:
                raise AssessmentError("invalid_noul")
            answer_value = noul_answer.model_dump()
        answers[question_id] = answer_value
    return answers


def abstained(
    reason_code: str,
    evaluator: Literal["jev", "deterministic", "manual"],
    requested_model: str | None,
    state: dict[str, Any],
    questions: dict[str, Question],
) -> Assessment:
    try:
        _payload, inputs_digest, rubric_hash = _bounded_request(
            state, requested_model or "none", questions
        )
    except AssessmentError:
        inputs_digest, rubric_hash = _fallback_digests(state, questions, reason_code)
    return Assessment(
        evaluator=evaluator,
        state="abstained",
        reason_code=reason_code,
        requested_model=requested_model,
        rubric_hash=rubric_hash,
        inputs_digest=inputs_digest,
    )


@dataclass
class JevProvider:
    """Optional TypeSafe HTTP adapter. It is inert until explicitly called with a key."""

    api_key: str | None
    model: str = JEV_DEFAULT_MODEL
    client: httpx.Client | None = None
    max_retries: int = 2
    retry_delay_seconds: float = 0.25
    sleep: Callable[[float], None] = time.sleep

    def evaluate(
        self, state: dict[str, Any], questions: dict[str, Question], deadline: float | None = None
    ) -> Assessment:
        try:
            payload, inputs_digest, rubric_hash = _bounded_request(state, self.model, questions)
        except AssessmentError as exc:
            return abstained(str(exc), "jev", self.model, state, questions)
        if not self.api_key:
            return Assessment(
                evaluator="jev",
                state="abstained",
                reason_code="missing_api_key",
                requested_model=self.model,
                rubric_hash=rubric_hash,
                inputs_digest=inputs_digest,
            )
        owned_client = self.client is None
        transport = self.client or httpx.Client(
            timeout=10.0, follow_redirects=False, trust_env=False
        )
        try:
            attempts = 0
            while True:
                attempts += 1
                if deadline is not None and deadline <= time.monotonic():
                    return Assessment(
                        evaluator="jev",
                        state="abstained",
                        reason_code="deadline_exhausted",
                        requested_model=self.model,
                        rubric_hash=rubric_hash,
                        inputs_digest=inputs_digest,
                    )
                timeout = REQUEST_TIMEOUT_SECONDS
                if deadline is not None:
                    timeout = min(REQUEST_TIMEOUT_SECONDS, max(0.001, deadline - time.monotonic()))
                try:
                    with transport.stream(
                        "POST",
                        JEV_URL,
                        headers={
                            "Authorization": "Bearer " + self.api_key,
                            "Content-Type": "application/json",
                        },
                        json=payload,
                        timeout=timeout,
                    ) as response:
                        if response.status_code in {429, 529} and attempts <= self.max_retries:
                            delay = min(
                                2.0, max(0.0, self.retry_delay_seconds) * (2 ** (attempts - 1))
                            )
                            if deadline is not None:
                                remaining = deadline - time.monotonic()
                                if remaining <= 0:
                                    return Assessment(
                                        evaluator="jev",
                                        state="abstained",
                                        reason_code="deadline_exhausted",
                                        requested_model=self.model,
                                        rubric_hash=rubric_hash,
                                        inputs_digest=inputs_digest,
                                    )
                                delay = min(delay, remaining)
                            if delay > 0:
                                self.sleep(delay)
                            continue
                        if response.status_code == 401:
                            reason = "auth_failed"
                        elif response.status_code == 422:
                            reason = "provider_schema_error"
                        elif response.status_code in {429, 529}:
                            reason = "provider_rate_limited"
                        elif response.status_code >= 400:
                            reason = "provider_error"
                        else:
                            reason = ""
                        if reason:
                            return Assessment(
                                evaluator="jev",
                                state="abstained",
                                reason_code=reason,
                                requested_model=self.model,
                                rubric_hash=rubric_hash,
                                inputs_digest=inputs_digest,
                            )
                        content = bytearray()
                        for chunk in response.iter_bytes():
                            if len(content) + len(chunk) > MAX_RESPONSE_BYTES:
                                return Assessment(
                                    evaluator="jev",
                                    state="abstained",
                                    reason_code="provider_response_too_large",
                                    requested_model=self.model,
                                    rubric_hash=rubric_hash,
                                    inputs_digest=inputs_digest,
                                )
                            content.extend(chunk)
                except (httpx.TimeoutException, httpx.NetworkError, httpx.StreamError):
                    return Assessment(
                        evaluator="jev",
                        state="abstained",
                        reason_code="timeout_or_network_error",
                        requested_model=self.model,
                        rubric_hash=rubric_hash,
                        inputs_digest=inputs_digest,
                    )
                try:
                    parsed = JevResponse.model_validate(json.loads(bytes(content)))
                    if parsed.model != self.model:
                        raise AssessmentError("provider_model_mismatch")
                    answers = validate_answers(parsed, questions)
                except (AssessmentError, ValueError, TypeError):
                    return Assessment(
                        evaluator="jev",
                        state="abstained",
                        reason_code="invalid_provider_response",
                        requested_model=self.model,
                        rubric_hash=rubric_hash,
                        inputs_digest=inputs_digest,
                    )
                return Assessment(
                    evaluator="jev",
                    state="evaluated",
                    reason_code="ok",
                    requested_model=self.model,
                    resolved_model=parsed.model,
                    rubric_hash=rubric_hash,
                    inputs_digest=inputs_digest,
                    answers=answers,
                    usage=parsed.usage,
                )
        finally:
            if owned_client:
                transport.close()


class DeterministicProvider:
    """A deliberately narrow fallback for exact synthetic marker checks."""

    def evaluate(
        self, state: dict[str, Any], questions: dict[str, Question], deadline: float | None = None
    ) -> Assessment:
        del deadline
        try:
            _payload, inputs_digest, rubric_hash = _bounded_request(
                state, "deterministic", questions
            )
        except AssessmentError as exc:
            return abstained(str(exc), "deterministic", None, state, questions)
        return Assessment(
            evaluator="deterministic",
            state="needs_review",
            reason_code="manual_review_required",
            rubric_hash=rubric_hash,
            inputs_digest=inputs_digest,
        )


class ManualReviewProvider:
    """Record an explicit review handoff without inventing an assessment."""

    def evaluate(
        self, state: dict[str, Any], questions: dict[str, Question], deadline: float | None = None
    ) -> Assessment:
        del deadline
        try:
            _payload, inputs_digest, rubric_hash = _bounded_request(
                state, "manual-review", questions
            )
        except AssessmentError as exc:
            return abstained(str(exc), "manual", None, state, questions)
        return Assessment(
            evaluator="manual",
            state="needs_review",
            reason_code="manual_review_required",
            rubric_hash=rubric_hash,
            inputs_digest=inputs_digest,
        )


__all__ = [
    "JEV_DEFAULT_MODEL",
    "JEV_URL",
    "DeterministicProvider",
    "JevProvider",
    "ManualReviewProvider",
    "abstained",
    "semantic_assessment_digests",
    "validate_answers",
]
