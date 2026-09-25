"""Typed assessment results; evaluators describe evidence and never hold authority."""

from __future__ import annotations

from typing import Any, Literal, Protocol

from pydantic import Field, FiniteFloat, model_validator

from plenger.domain.base import StrictModel
from plenger.evaluators.rubric import Question

ASSESSMENT_REDACTION_VERSION = "policy-v1"


class ChoiceAnswer(StrictModel):
    type: Literal["choice"]
    choice: str
    probabilities: dict[str, FiniteFloat]
    confidence: FiniteFloat = Field(ge=0, le=1)


class ScoreAnswer(StrictModel):
    type: Literal["score"]
    score: FiniteFloat
    legend: dict[str, Any]
    probabilities: dict[str, FiniteFloat]
    confidence: FiniteFloat = Field(ge=0, le=1)


class NoulAnswer(StrictModel):
    type: Literal["noul"]
    noul: FiniteFloat


class Usage(StrictModel):
    input_tokens: int = Field(ge=0)
    output_tokens: int = Field(ge=0)


class JevResponse(StrictModel):
    model: str = Field(min_length=1, max_length=128)
    answers: dict[str, dict[str, Any]]
    usage: Usage


class Assessment(StrictModel):
    evaluator: Literal["deterministic", "manual", "jev"]
    state: Literal["evaluated", "abstained", "needs_review"]
    reason_code: str = Field(min_length=1, max_length=128)
    requested_model: str | None = None
    resolved_model: str | None = None
    rubric_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    inputs_digest: str = Field(pattern=r"^[a-f0-9]{64}$")
    redaction_version: str = ASSESSMENT_REDACTION_VERSION
    answers: dict[str, dict[str, Any]] = Field(default_factory=dict)
    usage: Usage | None = None
    cached: bool = False
    cache_source_id: str | None = Field(default=None, min_length=1, max_length=64)

    @model_validator(mode="after")
    def valid_cache_metadata(self) -> Assessment:
        if self.cached != (self.cache_source_id is not None):
            raise ValueError("assessment_cache_metadata_invalid")
        return self


class AssessmentProvider(Protocol):
    def evaluate(
        self, state: dict[str, Any], questions: dict[str, Question], deadline: float | None = None
    ) -> Assessment: ...


class AssessmentError(ValueError):
    """Safe provider error; request and response bodies are intentionally omitted."""
