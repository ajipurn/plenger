import pytest
from sqlalchemy import text

from plenger.domain.runs import RunState
from plenger.services.application import project_id, queue_scan, recover_runs, run_status
from plenger.services.workspace import initialize
from plenger.storage.attempts import (
    finish_active_attempt,
    list_active_attempts,
    start_active_attempt,
)
from plenger.storage.database import open_store
from plenger.storage.runs import advance


def test_active_attempt_ledger_is_bounded_redacted_and_project_bound(tmp_path):
    initialize(tmp_path)
    run_id, _ = queue_scan(tmp_path, "deterministic", False, "attempt-ledger")
    engine = open_store(tmp_path)
    try:
        with engine.begin() as connection:
            start_active_attempt(
                connection,
                project_id(tmp_path),
                run_id,
                0,
                "LLM02-synthetic-disclosure",
                "LLM02",
            )
            finish_active_attempt(
                connection,
                project_id(tmp_path),
                run_id,
                0,
                {
                    "case_id": "LLM02-synthetic-disclosure",
                    "category": "LLM02",
                    "result": "pass",
                    "reason_code": "marker_not_observed",
                    "http_status": 200,
                    "evidence": ["response_observation", "sk-secret-SYNTHETIC0123456789"],
                    "untrusted_response": "must not persist",
                },
            )
            connection.execute(
                text("UPDATE active_attempts SET evidence=:evidence WHERE run_id=:run"),
                {
                    "evidence": '["sk-synthetic-read-secret123456"]',
                    "run": run_id,
                },
            )
        attempts = list_active_attempts(engine, project_id(tmp_path), run_id)
        assert len(attempts) == 1
        assert attempts[0]["attempt_index"] == 0
        assert attempts[0]["evidence"] == ["[REDACTED]"]
        assert "untrusted_response" not in str(attempts[0])
        assert list_active_attempts(engine, "foreign", run_id) == []
    finally:
        engine.dispose()


def test_in_flight_attempt_is_marked_interrupted_during_recovery(tmp_path):
    initialize(tmp_path)
    run_id, _ = queue_scan(tmp_path, "deterministic", False, "attempt-recovery")
    identity = project_id(tmp_path)
    engine = open_store(tmp_path)
    try:
        with engine.begin() as connection:
            advance(connection, identity, run_id, RunState.RUNNING)
            start_active_attempt(
                connection, identity, run_id, 0, "LLM06-tool-authorization", "LLM06"
            )
    finally:
        engine.dispose()

    assert recover_runs(tmp_path) == 1
    assert run_status(tmp_path, run_id)["state"] == "interrupted"
    engine = open_store(tmp_path)
    try:
        attempts = list_active_attempts(engine, identity, run_id)
        assert attempts[0]["result"] == "error"
        assert attempts[0]["reason_code"] == "process_interrupted"
    finally:
        engine.dispose()


def test_attempt_ledger_rejects_unknown_result(tmp_path):
    initialize(tmp_path)
    run_id, _ = queue_scan(tmp_path, "deterministic", False, "attempt-invalid-result")
    engine = open_store(tmp_path)
    try:
        with engine.begin() as connection:
            start_active_attempt(
                connection,
                project_id(tmp_path),
                run_id,
                0,
                "LLM01-direct-policy",
                "LLM01",
            )
            with pytest.raises(ValueError, match="invalid_attempt_result"):
                finish_active_attempt(
                    connection,
                    project_id(tmp_path),
                    run_id,
                    0,
                    {
                        "case_id": "LLM01-direct-policy",
                        "category": "LLM01",
                        "result": "unknown",
                        "reason_code": "synthetic",
                    },
                )
    finally:
        engine.dispose()
