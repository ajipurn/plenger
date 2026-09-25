"""Storage for evaluator assessments; it cannot mutate finding authority fields."""

import json
import uuid
from collections.abc import Sequence
from typing import Any

from sqlalchemy import text
from sqlalchemy.engine import Connection, Engine

from plenger.evaluators.models import Assessment
from plenger.policy.redaction import redact
from plenger.storage.runs import now

MAX_ASSESSMENT_PAGE_SIZE = 100

_NORMALIZED_ASSESSMENT_FIELDS = (
    "evaluator",
    "state",
    "reason_code",
    "requested_model",
    "resolved_model",
    "rubric_hash",
    "inputs_digest",
    "redaction_version",
)
_PAYLOAD_ONLY_ASSESSMENT_FIELDS = ("answers", "usage", "cached", "cache_source_id")


def find_cached_assessment(
    connection: Connection,
    project_id: str,
    evaluator: str,
    inputs_digest: str,
    rubric_hash: str,
    requested_model: str | None,
    resolved_model: str | None,
    redaction_version: str,
) -> dict[str, Any] | None:
    """Find one reusable assessment without crossing project or model boundaries."""

    row = (
        connection.execute(
            text(
                "SELECT * FROM assessments "
                "WHERE project_id=:project AND evaluator=:evaluator "
                "AND state != 'abstained' AND inputs_digest=:inputs "
                "AND rubric_hash=:rubric AND redaction_version=:redaction "
                "AND ((requested_model IS NULL AND :requested IS NULL) "
                "OR requested_model=:requested) "
                "AND ((resolved_model IS NULL AND :resolved IS NULL) "
                "OR resolved_model=:resolved) "
                "ORDER BY created_at DESC, id DESC LIMIT 1"
            ),
            {
                "project": project_id,
                "evaluator": evaluator,
                "inputs": inputs_digest,
                "rubric": rubric_hash,
                "redaction": redaction_version,
                "requested": requested_model,
                "resolved": resolved_model,
            },
        )
        .mappings()
        .first()
    )
    if row is None:
        return None
    return _deserialize([row])[0]


def save_assessment(
    connection: Connection,
    project_id: str,
    run_id: str,
    finding_id: str,
    assessment: Assessment,
) -> dict[str, Any]:
    identity = str(uuid.uuid4())
    created = now()
    safe_payload = redact(assessment.model_dump())
    connection.execute(
        text(
            "INSERT INTO assessments "
            "(id,project_id,run_id,finding_id,evaluator,state,reason_code,requested_model,"
            "resolved_model,rubric_hash,inputs_digest,redaction_version,payload,created_at) "
            "VALUES (:id,:project,:run,:finding,:evaluator,:state,:reason,:requested,:resolved,"
            ":rubric,:inputs,:redaction,:payload,:created)"
        ),
        {
            "id": identity,
            "project": project_id,
            "run": run_id,
            "finding": finding_id,
            "evaluator": assessment.evaluator,
            "state": assessment.state,
            "reason": assessment.reason_code,
            "requested": assessment.requested_model,
            "resolved": assessment.resolved_model,
            "rubric": assessment.rubric_hash,
            "inputs": assessment.inputs_digest,
            "redaction": assessment.redaction_version,
            "payload": json.dumps(safe_payload, ensure_ascii=False),
            "created": created,
        },
    )
    return {
        "id": identity,
        "project_id": project_id,
        "run_id": run_id,
        "finding_id": finding_id,
        "created_at": created,
        **safe_payload,
    }


def list_assessments(
    engine: Engine, project_id: str, run_id: str, finding_id: str | None = None
) -> list[dict[str, Any]]:
    """Read the complete assessment history for internal callers.

    The public assessment-history API uses :func:`list_assessments_page` so a
    caller cannot make that endpoint materialize an unbounded response.
    """

    query = "SELECT * FROM assessments WHERE project_id=:project AND run_id=:run"
    values: dict[str, Any] = {"project": project_id, "run": run_id}
    if finding_id is not None:
        query += " AND finding_id=:finding"
        values["finding"] = finding_id
    query += " ORDER BY created_at,id"
    with engine.connect() as connection:
        rows = connection.execute(text(query), values).mappings().all()
    return _deserialize(rows)


def list_assessments_page(
    engine: Engine,
    project_id: str,
    run_id: str,
    finding_id: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[dict[str, Any]], bool]:
    """Read one bounded, deterministic page of assessment history."""

    if not 1 <= limit <= MAX_ASSESSMENT_PAGE_SIZE or offset < 0:
        raise ValueError("invalid_assessment_pagination")
    query = "SELECT * FROM assessments WHERE project_id=:project AND run_id=:run"
    values: dict[str, Any] = {
        "project": project_id,
        "run": run_id,
        "limit": limit + 1,
        "offset": offset,
    }
    if finding_id is not None:
        query += " AND finding_id=:finding"
        values["finding"] = finding_id
    query += " ORDER BY created_at,id LIMIT :limit OFFSET :offset"
    with engine.connect() as connection:
        rows = connection.execute(text(query), values).mappings().all()
    has_more = len(rows) > limit
    return _deserialize(rows[:limit]), has_more


def count_assessments(
    engine: Engine, project_id: str, run_id: str, finding_id: str | None = None
) -> int:
    """Count normalized assessment rows without loading their payloads."""

    query = "SELECT COUNT(*) FROM assessments WHERE project_id=:project AND run_id=:run"
    values: dict[str, Any] = {"project": project_id, "run": run_id}
    if finding_id is not None:
        query += " AND finding_id=:finding"
        values["finding"] = finding_id
    with engine.connect() as connection:
        return int(connection.execute(text(query), values).scalar_one())


def _deserialize(rows: Sequence[Any]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for row in rows:
        item = dict(row)
        try:
            payload = json.loads(item.pop("payload"))
        except (TypeError, json.JSONDecodeError):
            raise ValueError("invalid_assessment_payload") from None
        if not isinstance(payload, dict):
            raise ValueError("invalid_assessment_payload")
        payload = redact(payload)

        # The normalized columns are the authority for identity and assessment
        # metadata.  Only fields without dedicated columns may come from the
        # JSON payload; otherwise a tampered payload could rewrite the row's
        # project, run, finding, or evaluator metadata at read time.
        assessment_data = {field: item[field] for field in _NORMALIZED_ASSESSMENT_FIELDS}
        assessment_data.update(
            {field: payload[field] for field in _PAYLOAD_ONLY_ASSESSMENT_FIELDS if field in payload}
        )
        try:
            validated = Assessment.model_validate(assessment_data)
        except (TypeError, ValueError):
            raise ValueError("invalid_assessment_payload") from None
        item.update(validated.model_dump())
        result.append(item)
    return result
