"""Run-scoped deterministic/Jev assessment orchestration."""

import json
import os
from collections.abc import Sequence
from pathlib import Path
from typing import Any, Literal

from sqlalchemy import text

from plenger.evaluators.models import ASSESSMENT_REDACTION_VERSION, Assessment, AssessmentError
from plenger.evaluators.providers import (
    JEV_DEFAULT_MODEL,
    DeterministicProvider,
    JevProvider,
    ManualReviewProvider,
    semantic_assessment_digests,
)
from plenger.evaluators.rubric import QUESTIONS
from plenger.policy.consent import HOSTED_DATA_CLASSES, normalize_data_classes
from plenger.services.application import project_id
from plenger.services.integrity import redact_preserving_integrity
from plenger.services.reports import latest
from plenger.services.workspace import load_config
from plenger.storage.assessments import (
    count_assessments,
    find_cached_assessment,
    list_assessments,
    list_assessments_page,
    save_assessment,
)
from plenger.storage.consents import (
    grant_consent,
    has_effective_consent,
    project_config_hash,
    revoke_consent,
)
from plenger.storage.database import open_store
from plenger.storage.runs import RunConflict

JEV_CONSENT_DOMAIN = "api.typesafe.ai"
JEV_CONSENT_DATA_CLASSES = ("metadata", "code_excerpt", "response")
ASSESSMENT_REPORT_VIEW_LIMIT = 100


def _evidence_data_class(evidence: dict[str, Any]) -> str:
    """Classify an evidence excerpt so hosted consent can bound what leaves the host."""

    source = str(evidence.get("source", "")).lower()
    if "trace" in source or "observer" in source:
        return "trace"
    if "prompt" in source and "promptfoo" not in source:
        return "prompt"
    if "response" in source or "promptfoo" in source or "broker" in source:
        return "response"
    return "code_excerpt"


def _state(
    finding: dict[str, Any], data_classes: Sequence[str] = tuple(sorted(HOSTED_DATA_CLASSES))
) -> dict[str, Any]:
    """Build evaluator state containing only the consented data classes."""

    allowed = set(data_classes)
    evidence_items: list[dict[str, Any]] = []
    evidence = finding.get("evidence")
    if isinstance(evidence, dict):
        evidence_items.append(evidence)
    extra_evidence = finding.get("evidence_refs")
    if isinstance(extra_evidence, list):
        evidence_items.extend(item for item in extra_evidence if isinstance(item, dict))
    excerpts = [
        str(item.get("observed", ""))[:2000]
        for item in evidence_items
        if _evidence_data_class(item) in allowed
    ]
    artifact_digests = [
        item["sha256_redacted"]
        for item in evidence_items
        if isinstance(item.get("sha256_redacted"), str) and len(item["sha256_redacted"]) == 64
    ]
    metadata = "metadata" in allowed
    return {
        "trusted_policy": "A candidate is not confirmed without sufficient evidence and review.",
        "deterministic_facts": (
            {
                "validation_state": finding.get("validation_state"),
                "evidence_integrity": finding.get("evidence_integrity"),
                "source_ref": finding.get("source_ref"),
                "finding_claim": {
                    "fingerprint": finding.get("fingerprint"),
                    "rule_id": finding.get("rule_id"),
                    "kind": finding.get("kind"),
                    "title": finding.get("title"),
                },
            }
            if metadata
            else {}
        ),
        # Use content identities rather than run-scoped evidence row IDs so the
        # semantic cache can match the same redacted artifact in a later run.
        "evidence_refs": artifact_digests if metadata else [],
        "untrusted_observation": {
            "output_excerpt": excerpts[0] if excerpts else "",
            "additional_output_excerpts": excerpts[1:8],
        },
    }


def _semantic_cache_key(
    provider: Literal["deterministic", "manual", "jev"], state: dict[str, Any]
) -> tuple[str, str, str, str | None, str | None, str] | None:
    """Build the exact cache identity for providers safe to reuse semantically."""

    deterministic_facts = state.get("deterministic_facts")
    if (
        not isinstance(deterministic_facts, dict)
        or deterministic_facts.get("evidence_integrity") != "verified"
    ):
        return None

    if provider == "deterministic":
        evaluator = "deterministic"
        model_for_digest = "deterministic"
        requested_model = None
        resolved_model = None
    elif provider == "jev":
        evaluator = "jev"
        model_for_digest = JEV_DEFAULT_MODEL
        requested_model = JEV_DEFAULT_MODEL
        resolved_model = JEV_DEFAULT_MODEL
    else:
        return None
    try:
        inputs_digest, rubric_hash = semantic_assessment_digests(state, model_for_digest, QUESTIONS)
    except AssessmentError:
        return None
    return (
        evaluator,
        inputs_digest,
        rubric_hash,
        requested_model,
        resolved_model,
        ASSESSMENT_REDACTION_VERSION,
    )


def _assessment_from_cache(row: dict[str, Any]) -> Assessment:
    fields = {
        name: row[name]
        for name in (
            "evaluator",
            "state",
            "reason_code",
            "requested_model",
            "resolved_model",
            "rubric_hash",
            "inputs_digest",
            "redaction_version",
            "answers",
            "usage",
        )
    }
    assessment = Assessment.model_validate(fields)
    # The normalized row id is the cache provenance authority.  A payload field
    # cannot redirect a cache hit to an attacker-selected assessment id.
    source_id = row.get("id")
    if not isinstance(source_id, str) or not source_id:
        raise ValueError("assessment_cache_source_invalid")
    return assessment.model_copy(update={"cached": True, "cache_source_id": source_id})


def evaluate_finding(
    root: Path,
    run_id: str,
    finding_id: str,
    provider: Literal["deterministic", "manual", "jev"],
    consent: bool,
    data_classes: Sequence[str] | None = None,
    consent_actor: str = "local-user",
) -> dict[str, Any]:
    load_config(root)
    if provider not in {"deterministic", "manual", "jev"}:
        raise ValueError("unsupported_assessment_provider")
    report = latest(root, run_id)
    identity = project_id(root)
    if report is None:
        raise RunConflict("run_not_found")
    finding = next(
        (item for item in report.get("findings", []) if item.get("id") == finding_id), None
    )
    if finding is None:
        raise RunConflict("finding_not_found")
    requested_classes: tuple[str, ...] = tuple(sorted(HOSTED_DATA_CLASSES))
    if provider == "jev":
        requested_classes = normalize_data_classes(data_classes or JEV_CONSENT_DATA_CLASSES)
        if consent:
            grant_hosted_consent_for_project(
                root,
                provider,
                requested_classes,
                actor=consent_actor,
            )
        else:
            engine = open_store(root)
            try:
                config_hash = _config_hash(engine, identity)
                if not has_effective_consent(
                    engine,
                    identity,
                    config_hash,
                    provider,
                    requested_classes,
                    JEV_CONSENT_DOMAIN,
                ):
                    raise PermissionError("hosted_consent_required")
            finally:
                engine.dispose()
    # Hosted state carries only the consented classes; local evaluators see all.
    state = _state(finding, requested_classes)
    engine = open_store(root)
    try:
        assessment: Assessment | None = None
        cache_key = _semantic_cache_key(provider, state)
        if cache_key is not None:
            (
                evaluator,
                inputs_digest,
                rubric_hash,
                requested_model,
                resolved_model,
                redaction_version,
            ) = cache_key
            with engine.connect() as connection:
                cached = find_cached_assessment(
                    connection,
                    identity,
                    evaluator,
                    inputs_digest,
                    rubric_hash,
                    requested_model,
                    resolved_model,
                    redaction_version,
                )
            if cached is not None:
                assessment = _assessment_from_cache(cached)
        if assessment is None:
            if provider == "jev":
                assessment = JevProvider(os.environ.get("TYPESAFE_API_KEY")).evaluate(
                    state, QUESTIONS
                )
            elif provider == "manual":
                assessment = ManualReviewProvider().evaluate(state, QUESTIONS)
            else:
                assessment = DeterministicProvider().evaluate(state, QUESTIONS)
        with engine.begin() as connection:
            result = save_assessment(connection, identity, run_id, finding_id, assessment)
            # Keep the report as a view cache; authority fields are untouched. Read the
            # current payload after acquiring the SQLite writer reservation so concurrent
            # assessments cannot overwrite each other's view-cache entry.
            row = connection.execute(
                text("SELECT payload FROM reports WHERE id=:run AND project_id=:project"),
                {"run": run_id, "project": identity},
            ).first()
            if row is None:
                raise RunConflict("run_not_found")
            try:
                current_report = json.loads(row[0])
            except (TypeError, json.JSONDecodeError):
                raise RunConflict("run_not_found") from None
            if not isinstance(current_report, dict):
                raise RunConflict("run_not_found")
            assessments = current_report.get("assessments")
            if not isinstance(assessments, list):
                assessments = []
            assessments.append(result)
            current_report["assessments"] = assessments[-ASSESSMENT_REPORT_VIEW_LIMIT:]
            current_report = redact_preserving_integrity(current_report)
            connection.execute(
                text("UPDATE reports SET payload=:payload WHERE id=:run AND project_id=:project"),
                {
                    "payload": json.dumps(current_report, ensure_ascii=False),
                    "run": run_id,
                    "project": identity,
                },
            )
    finally:
        engine.dispose()
    return result


def assessments_for_run(
    root: Path, run_id: str, finding_id: str | None = None
) -> list[dict[str, Any]]:
    load_config(root)
    engine = open_store(root)
    try:
        return list_assessments(engine, project_id(root), run_id, finding_id)
    finally:
        engine.dispose()


def assessments_page_for_run(
    root: Path,
    run_id: str,
    finding_id: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[dict[str, Any]], bool]:
    """Read a bounded assessment-history page for the API."""

    load_config(root)
    engine = open_store(root)
    try:
        return list_assessments_page(
            engine,
            project_id(root),
            run_id,
            finding_id,
            limit,
            offset,
        )
    finally:
        engine.dispose()


def assessment_count_for_run(root: Path, run_id: str, finding_id: str | None = None) -> int:
    """Return the complete normalized assessment count for a report overview."""

    load_config(root)
    engine = open_store(root)
    try:
        return count_assessments(engine, project_id(root), run_id, finding_id)
    finally:
        engine.dispose()


def _config_hash(engine: Any, identity: str) -> str:
    with engine.connect() as connection:
        return project_config_hash(connection, identity)


def assessment_consent_preview(root: Path, provider: Literal["jev"] = "jev") -> dict[str, Any]:
    """Return the exact hosted scope the UI must display before consent."""

    load_config(root)
    identity = project_id(root)
    engine = open_store(root)
    try:
        config_hash = _config_hash(engine, identity)
        granted = has_effective_consent(
            engine,
            identity,
            config_hash,
            provider,
            JEV_CONSENT_DATA_CLASSES,
            JEV_CONSENT_DOMAIN,
        )
    finally:
        engine.dispose()
    return {
        "provider": provider,
        "domain": JEV_CONSENT_DOMAIN,
        "data_classes": list(JEV_CONSENT_DATA_CLASSES),
        "config_hash": config_hash,
        "granted": granted,
    }


def grant_hosted_consent_for_project(
    root: Path,
    provider: Literal["jev"],
    data_classes: Sequence[str],
    *,
    actor: str = "local-user",
) -> dict[str, Any]:
    """Persist an explicit hosted scope; repository config cannot create it."""

    load_config(root)
    classes = normalize_data_classes(data_classes)
    required = set(JEV_CONSENT_DATA_CLASSES)
    if provider != "jev" or not required.issubset(classes):
        raise ValueError("invalid_jev_consent_scope")
    identity = project_id(root)
    engine = open_store(root)
    try:
        with engine.begin() as connection:
            config_hash = project_config_hash(connection, identity)
            return grant_consent(
                connection,
                identity,
                config_hash,
                provider,
                classes,
                JEV_CONSENT_DOMAIN,
                actor,
            )
    finally:
        engine.dispose()


def revoke_hosted_consent_for_project(root: Path) -> bool:
    """Revoke the current Jev scope without touching stored assessments."""

    load_config(root)
    identity = project_id(root)
    engine = open_store(root)
    try:
        with engine.begin() as connection:
            config_hash = project_config_hash(connection, identity)
            return revoke_consent(
                connection,
                identity,
                config_hash,
                "jev",
                JEV_CONSENT_DATA_CLASSES,
                JEV_CONSENT_DOMAIN,
            )
    finally:
        engine.dispose()
