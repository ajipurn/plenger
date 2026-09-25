"""Bounded Promptfoo result import and native fixed-case replay.

This module never loads Promptfoo config, plugins, providers, or repository
scripts. Imported output is evidence from an external run; replay uses only the
plenger broker and reviewed native cases.
"""

from __future__ import annotations

import json
from typing import Any, Literal

from pydantic import Field

from plenger.broker import RequestBroker
from plenger.domain.base import StrictModel
from plenger.policy.active import PlanSpec
from plenger.policy.redaction import redact
from plenger.runner import run_fixed_cases

MAX_OUTPUT_BYTES = 64 * 1024 * 1024
PromptfooStatus = Literal["pass", "fail", "inconclusive", "error"]


class PromptfooCaseResult(StrictModel):
    case_id: str = Field(min_length=1, max_length=128)
    provider_ref: str = Field(min_length=1, max_length=128)
    status: PromptfooStatus
    output_excerpt: str = Field(default="", max_length=2000)
    assertion_count: int = Field(default=0, ge=0, le=256)
    source: Literal["promptfoo-import"] = "promptfoo-import"


class PromptfooImport(StrictModel):
    status: Literal["completed", "incomplete", "error"]
    reason: str = Field(min_length=1, max_length=128)
    results: list[PromptfooCaseResult] = Field(max_length=40)


class PromptfooImportError(ValueError):
    pass


def _bounded_json(raw: bytes | str) -> dict[str, Any]:
    encoded = raw.encode() if isinstance(raw, str) else raw
    if len(encoded) > MAX_OUTPUT_BYTES:
        raise PromptfooImportError("promptfoo_output_too_large")
    try:
        value = json.loads(encoded)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise PromptfooImportError("malformed_promptfoo_output") from None
    if not isinstance(value, dict):
        raise PromptfooImportError("promptfoo_output_not_object")
    return value


def _status(value: Any) -> PromptfooStatus:
    if value in {"pass", "passed", True}:
        return "pass"
    if value in {"fail", "failed", False}:
        return "fail"
    if value in {"inconclusive", "skipped", "blocked"}:
        return "inconclusive"
    if value in {"error", "errored"}:
        return "error"
    raise PromptfooImportError("invalid_promptfoo_status")


def import_promptfoo(raw: bytes | str) -> PromptfooImport:
    value = _bounded_json(raw)
    raw_results = value.get("results")
    if not isinstance(raw_results, list) or len(raw_results) > 40:
        raise PromptfooImportError("invalid_promptfoo_results")
    results: list[PromptfooCaseResult] = []
    for item in raw_results:
        if not isinstance(item, dict):
            raise PromptfooImportError("invalid_promptfoo_result")
        case_id = item.get("id", item.get("testIdx"))
        if not isinstance(case_id, (str, int)):
            raise PromptfooImportError("promptfoo_case_id_required")
        provider = item.get("provider", "unknown")
        if isinstance(provider, dict):
            provider = provider.get("id", "unknown")
        if not isinstance(provider, str):
            raise PromptfooImportError("invalid_promptfoo_provider")
        response = item.get("response", item.get("output", ""))
        if isinstance(response, (dict, list)):
            response = json.dumps(response, ensure_ascii=False, separators=(",", ":"))
        excerpt = str(redact(response))[:2000]
        assertions = item.get("gradingResult", item.get("assertions", []))
        assertion_count = len(assertions) if isinstance(assertions, list) else 0
        results.append(
            PromptfooCaseResult(
                case_id=str(case_id),
                provider_ref=provider,
                status=_status(item.get("status", item.get("success"))),
                output_excerpt=excerpt,
                assertion_count=assertion_count,
            )
        )
    return PromptfooImport(
        status="completed",
        reason="validated_import",
        results=results,
    )


def replay_fixed_cases(broker: RequestBroker, plan: PlanSpec) -> list[dict[str, Any]]:
    """Replay only reviewed native cases; never execute imported provider data."""

    return [
        dict(result, source="plenger-native-replay") for result in run_fixed_cases(broker, plan)
    ]


def capability() -> dict[str, str]:
    return {
        "status": "ready",
        "reason": "validated_import_and_native_fixed_replay",
    }


__all__ = [
    "PromptfooCaseResult",
    "PromptfooImport",
    "PromptfooImportError",
    "capability",
    "import_promptfoo",
    "replay_fixed_cases",
]
