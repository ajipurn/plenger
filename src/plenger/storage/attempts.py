"""Bounded, redacted active-case attempt ledger."""

import json
import uuid
from typing import Any

from sqlalchemy import text
from sqlalchemy.engine import Connection, Engine

from plenger.policy.redaction import redact
from plenger.storage.runs import now

_VALID_ATTEMPT_RESULTS = frozenset(
    {"pass", "fail", "inconclusive", "error", "blocked", "skipped", "in_flight"}
)


def _safe_attempt(result: dict[str, Any]) -> dict[str, Any]:
    evidence = result.get("evidence", [])
    safe_evidence = (
        [str(item)[:128] for item in evidence[:16]] if isinstance(evidence, list) else []
    )
    http_status = result.get("http_status")
    safe_result = str(result.get("result", ""))[:32]
    if safe_result not in _VALID_ATTEMPT_RESULTS:
        raise ValueError("invalid_attempt_result")
    return {
        "case_id": str(result.get("case_id", ""))[:128],
        "category": str(result.get("category", ""))[:16],
        "result": safe_result,
        "reason_code": str(result.get("reason_code", ""))[:128],
        "http_status": http_status
        if isinstance(http_status, int) and 100 <= http_status <= 599
        else None,
        "evidence": safe_evidence,
    }


def record_active_attempt(
    connection: Connection,
    project_id: str,
    run_id: str,
    attempt_index: int,
    result: dict[str, Any],
) -> dict[str, Any]:
    if attempt_index < 0:
        raise ValueError("invalid_attempt_index")
    safe = _safe_attempt(redact(result))
    if not safe["case_id"] or not safe["category"] or not safe["result"] or not safe["reason_code"]:
        raise ValueError("invalid_attempt_result")
    identity = str(uuid.uuid4())
    created = now()
    connection.execute(
        text(
            "INSERT INTO active_attempts "
            "(id,run_id,project_id,attempt_index,case_id,category,result,reason_code,http_status,"
            "evidence,created_at) "
            "VALUES (:id,:run,:project,:index,:case,:category,:result,:reason,:status,:evidence,"
            ":created)"
        ),
        {
            "id": identity,
            "run": run_id,
            "project": project_id,
            "index": attempt_index,
            "case": safe["case_id"],
            "category": safe["category"],
            "result": safe["result"],
            "reason": safe["reason_code"],
            "status": safe["http_status"],
            "evidence": json.dumps(safe["evidence"], ensure_ascii=False),
            "created": created,
        },
    )
    return {
        "id": identity,
        "run_id": run_id,
        "project_id": project_id,
        **safe,
        "created_at": created,
    }


def start_active_attempt(
    connection: Connection,
    project_id: str,
    run_id: str,
    attempt_index: int,
    case_id: str,
    category: str,
) -> dict[str, Any]:
    """Persist an in-flight attempt before a target dispatch is attempted."""

    if attempt_index < 0 or not case_id or len(case_id) > 128 or not category:
        raise ValueError("invalid_attempt_start")
    return record_active_attempt(
        connection,
        project_id,
        run_id,
        attempt_index,
        {
            "case_id": case_id,
            "category": category,
            "result": "in_flight",
            "reason_code": "dispatch_started",
            "evidence": [],
        },
    )


def finish_active_attempt(
    connection: Connection,
    project_id: str,
    run_id: str,
    attempt_index: int,
    result: dict[str, Any],
) -> dict[str, Any] | None:
    """Replace the bounded in-flight marker with the final case outcome."""

    safe = _safe_attempt(redact(result))
    if not safe["case_id"] or not safe["category"] or not safe["result"]:
        raise ValueError("invalid_attempt_result")
    changed = connection.execute(
        text(
            "UPDATE active_attempts SET case_id=:case,category=:category,result=:result,"
            "reason_code=:reason,http_status=:status,evidence=:evidence "
            "WHERE project_id=:project AND run_id=:run AND attempt_index=:index "
            "AND result='in_flight'"
        ),
        {
            "case": safe["case_id"],
            "category": safe["category"],
            "result": safe["result"],
            "reason": safe["reason_code"],
            "status": safe["http_status"],
            "evidence": json.dumps(safe["evidence"], ensure_ascii=False),
            "project": project_id,
            "run": run_id,
            "index": attempt_index,
        },
    )
    if changed.rowcount != 1:
        return None
    return {
        "project_id": project_id,
        "run_id": run_id,
        "attempt_index": attempt_index,
        **safe,
    }


def mark_interrupted_active_attempts(engine: Engine, project_id: str, run_ids: list[str]) -> int:
    """Make crash residue explicit without deleting the attempt accounting."""

    changed = 0
    with engine.begin() as connection:
        for run_id in run_ids:
            result = connection.execute(
                text(
                    "UPDATE active_attempts SET result='error',reason_code='process_interrupted' "
                    "WHERE project_id=:project AND run_id=:run AND result='in_flight'"
                ),
                {"project": project_id, "run": run_id},
            )
            changed += result.rowcount
    return changed


def list_active_attempts(engine: Engine, project_id: str, run_id: str) -> list[dict[str, Any]]:
    with engine.connect() as connection:
        rows = (
            connection.execute(
                text(
                    "SELECT id,run_id,project_id,attempt_index,case_id,category,result,reason_code,"
                    "http_status,evidence,created_at FROM active_attempts "
                    "WHERE project_id=:project AND run_id=:run ORDER BY attempt_index"
                ),
                {"project": project_id, "run": run_id},
            )
            .mappings()
            .all()
        )
    result: list[dict[str, Any]] = []
    for row in rows:
        item = dict(row)
        try:
            item["evidence"] = json.loads(item["evidence"])
        except (TypeError, json.JSONDecodeError):
            item["evidence"] = []
        result.append(redact(item))
    return result
