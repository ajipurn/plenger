import json

import pytest

from plenger.domain.runs import RunState, transition
from plenger.graph.worker import analyze
from plenger.services.application import export_report


@pytest.mark.parametrize("state", list(RunState))
def test_terminal_cannot_restart(state):
    with pytest.raises(ValueError):
        transition(RunState.COMPLETED, state)


def test_run_transitions():
    state = RunState.PLANNED
    for next_state in [RunState.QUEUED, RunState.RUNNING, RunState.CANCELLING, RunState.CANCELLED]:
        state = transition(state, next_state)
    assert state == RunState.CANCELLED


@pytest.mark.parametrize(
    "source, symbols, candidates",
    [
        ("def f(x):\n return eval(x)", 1, 1),
        ("async def f(x):\n return exec(x)", 1, 1),
        ("class C:\n def f(self): pass", 2, 0),
        ('raise RuntimeError("must not run")\ndef f(): pass', 1, 0),
        ("import ast\ndef f(x): return ast.literal_eval(x)", 1, 0),
        ('# eval(x)\ns = "exec(x)"', 0, 0),
        ("def outer():\n def inner(): pass\n return inner", 2, 0),
    ],
)
def test_parser_supported_grammar(source, symbols, candidates):
    result = analyze({"test.py": source}, "project")
    assert len(result["nodes"]) == symbols + 1
    assert len(result["edges"]) == symbols
    assert len(result["findings"]) == candidates
    assert all(edge["provenance"] == "observed_static" for edge in result["edges"])
    ids = {node["id"] for node in result["nodes"]}
    assert all(edge["source"] in ids and edge["target"] in ids for edge in result["edges"])


def test_invalid_source_is_error_not_clean():
    assert analyze({"bad.py": "def broken("}, "p")["errors"]


def test_repeated_symbols_distinct_and_lines_do_not_change_fingerprint():
    result = analyze({"a.py": "def f(): pass\ndef f(): pass"}, "p")
    assert len({n["id"] for n in result["nodes"]}) == 3
    first = analyze({"a.py": "def f(x): return eval(x)"}, "p")["findings"][0]
    moved = analyze({"a.py": "\n\ndef f(x): return eval(x)"}, "p")["findings"][0]
    assert first["fingerprint"] == moved["fingerprint"]


def test_exports_inert_and_redacted():
    marker = "sk-syntheticSECRET123456789"
    value = {"payload": "<script>alert(1)</script>", "secret": marker}
    output = export_report(value, "html")
    assert "<script>" not in output and "&lt;script&gt;" in output
    assert marker not in output
    assert json.loads(export_report(value, "json"))["secret"] == "[REDACTED]"


def test_redaction_masks_plain_sensitive_fields_but_keeps_token_metadata():
    from plenger.policy.redaction import redact

    value = {
        "secret": "plain-synthetic-secret",
        "secretKey": "plain-synthetic-camel-secret",
        "password": "plain-synthetic-password",
        "api_key": "plain-synthetic-key",
        "token": "plain-synthetic-token",
        "token_count": 3,
        "nested": {"access-token": "plain-synthetic-access-token"},
    }

    result = redact(value)

    assert result == {
        "secret": "[REDACTED]",
        "secretKey": "[REDACTED]",
        "password": "[REDACTED]",
        "api_key": "[REDACTED]",
        "token": "[REDACTED]",
        "token_count": 3,
        "nested": {"access-token": "[REDACTED]"},
    }


def test_redaction_does_not_match_token_prefix_inside_product_markers():
    from plenger.policy.redaction import redact

    marker = "PLENGER_SYNTHETIC_DISCLOSURE_MARKER"

    assert redact(marker) == marker


def test_save_report_redacts_before_persistence(tmp_path):
    from sqlalchemy import text

    from plenger.services.application import project_id
    from plenger.storage.database import open_store, reports, save_report

    engine = open_store(tmp_path)
    try:
        save_report(
            engine,
            {
                "run_id": "redacted-report",
                "project_id": project_id(tmp_path),
                "secretKey": "plain-synthetic-secret",
                "token_count": 3,
            },
        )
        with engine.begin() as connection:
            raw_payload = connection.execute(
                text("SELECT payload FROM reports WHERE id=:id"),
                {"id": "redacted-report"},
            ).scalar_one()
            assert "plain-synthetic-secret" not in raw_payload
            connection.execute(
                text("UPDATE reports SET payload=:payload WHERE id=:id"),
                {
                    "id": "redacted-report",
                    "payload": json.dumps(
                        {
                            "run_id": "redacted-report",
                            "project_id": project_id(tmp_path),
                            "secretKey": "plain-synthetic-secret",
                            "token_count": 3,
                        }
                    ),
                },
            )
        stored = reports(engine, project_id(tmp_path), "redacted-report")
    finally:
        engine.dispose()

    assert stored == {
        "run_id": "redacted-report",
        "project_id": project_id(tmp_path),
        "secretKey": "[REDACTED]",
        "token_count": 3,
    }


def test_worker_schema_rejects_forged_refs_and_authority():
    from pydantic import ValidationError

    from plenger.domain.parser import ParserResult

    result = analyze({"a.py": "def f(x): return eval(x)"}, "p")
    assert ParserResult.model_validate(result)
    result["findings"][0]["validation_state"] = "confirmed"
    with pytest.raises(ValidationError):
        ParserResult.model_validate(result)
    result["findings"][0]["validation_state"] = "candidate"
    result["nodes"][0]["source_ref"]["path"] = "../private.py"
    with pytest.raises(ValidationError):
        ParserResult.model_validate(result)


def test_missing_sandbox_never_executes_target(monkeypatch):
    from plenger.adapters import python_parser as adapters

    monkeypatch.setattr(adapters, "probe", lambda: {"status": "unavailable"})
    with pytest.raises(adapters.SandboxError, match="sandbox_unavailable"):
        adapters.execute({"a.py": 'raise Exception("do not execute")'}, "project")


def test_migration_reopen_preserves_evidence(tmp_path):
    from sqlalchemy import text

    from plenger.storage.database import open_store, reports, save_report

    engine = open_store(tmp_path)
    save_report(engine, {"run_id": "r", "project_id": "p", "findings": ["metadata"]})
    engine.dispose()
    engine = open_store(tmp_path)
    assert reports(engine, "p", "r")["findings"] == ["metadata"]
    assert reports(engine, "different-project", "r") is None
    with engine.connect() as connection:
        assert connection.execute(text("PRAGMA foreign_keys")).scalar() == 1
        assert (
            connection.execute(text("SELECT version_num FROM alembic_version")).scalar() == "0015"
        )
        assert (
            connection.execute(
                text(
                    "SELECT name FROM sqlite_master "
                    "WHERE type='index' AND name='ix_assessments_semantic_cache'"
                )
            ).scalar()
            == "ix_assessments_semantic_cache"
        )
    engine.dispose()


def test_migration_reopen_preserves_normalized_findings_and_run_events(tmp_path):
    from sqlalchemy import text

    from plenger.services.application import project_id, queue_scan
    from plenger.services.workspace import initialize
    from plenger.storage.database import open_store, save_report
    from plenger.storage.findings import persist_report_entities

    initialize(tmp_path)
    run_id, _ = queue_scan(tmp_path, "deterministic", False, "migration-integrity")
    identity = project_id(tmp_path)
    snapshot_id = "s" * 36
    finding_id = "f" * 64
    evidence_id = "e" * 64
    report = {
        "run_id": run_id,
        "project_id": identity,
        "snapshot_id": snapshot_id,
        "findings": [
            {
                "id": finding_id,
                "fingerprint": "p" * 64,
                "rule_id": "WK-MIGRATION-001",
                "kind": "migration_fixture",
                "severity": "info",
                "severity_source": "test",
                "validation_state": "candidate",
                "lifecycle_state": "open",
                "assessment_state": "needs_review",
                "title": "Migration fixture",
                "source_ref": {"path": "fixture.py", "line": 1},
                "evidence": {
                    "id": evidence_id,
                    "source": "migration-test",
                    "observed": "bounded migration evidence",
                    "redaction_version": "test-v1",
                    "sha256_redacted": "d" * 64,
                },
            }
        ],
    }
    engine = open_store(tmp_path)
    try:
        with engine.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO snapshots "
                    "(id,run_id,project_id,manifest_digest,payload) "
                    "VALUES (:id,:run,:project,:digest,:payload)"
                ),
                {
                    "id": snapshot_id,
                    "run": run_id,
                    "project": identity,
                    "digest": "m" * 64,
                    "payload": json.dumps({"id": snapshot_id}),
                },
            )
            persist_report_entities(connection, report)
        save_report(engine, report)
    finally:
        engine.dispose()

    engine = open_store(tmp_path)
    try:
        with engine.connect() as connection:
            assert (
                connection.execute(text("SELECT version_num FROM alembic_version")).scalar()
                == "0015"
            )
            assert (
                connection.execute(
                    text("SELECT COUNT(*) FROM run_events WHERE run_id=:run"), {"run": run_id}
                ).scalar_one()
                == 1
            )
            assert (
                connection.execute(
                    text("SELECT COUNT(*) FROM finding_records WHERE id=:finding"),
                    {"finding": finding_id},
                ).scalar_one()
                == 1
            )
            assert (
                connection.execute(
                    text("SELECT COUNT(*) FROM evidence_artifacts WHERE id=:evidence"),
                    {"evidence": evidence_id},
                ).scalar_one()
                == 1
            )
    finally:
        engine.dispose()


def test_legacy_migration_upgrade_preserves_report_and_rejects_downgrade(tmp_path):
    import os
    from pathlib import Path

    from alembic import command
    from alembic.config import Config
    from sqlalchemy import create_engine, text

    from plenger.services.workspace import initialize
    from plenger.storage.database import open_store, reports

    initialize(tmp_path)
    private = tmp_path / ".plenger"
    private.mkdir(mode=0o700)
    os.chmod(private, 0o700)
    database = private / "state.sqlite3"
    database.touch(mode=0o600)
    os.chmod(database, 0o600)

    migration_config = Config()
    migration_config.set_main_option(
        "script_location",
        str(Path(__file__).resolve().parents[2] / "src/plenger/storage/migrations"),
    )
    legacy_engine = create_engine("sqlite:///" + str(database))
    try:
        with legacy_engine.begin() as connection:
            migration_config.attributes["connection"] = connection
            command.upgrade(migration_config, "0001")
            connection.execute(
                text("INSERT INTO reports (id,project_id,payload) VALUES (:id,:project,:payload)"),
                {
                    "id": "legacy-run",
                    "project": "legacy-project",
                    "payload": json.dumps(
                        {"run_id": "legacy-run", "project_id": "legacy-project", "findings": []}
                    ),
                },
            )
    finally:
        legacy_engine.dispose()

    engine = open_store(tmp_path)
    try:
        with engine.connect() as connection:
            assert (
                connection.execute(text("SELECT version_num FROM alembic_version")).scalar()
                == "0015"
            )
        assert reports(engine, "legacy-project", "legacy-run") == {
            "run_id": "legacy-run",
            "project_id": "legacy-project",
            "findings": [],
        }

        with pytest.raises(
            RuntimeError, match="rollback_requires_backup_and_explicit_data_migration"
        ):
            with engine.begin() as connection:
                migration_config.attributes["connection"] = connection
                command.downgrade(migration_config, "-1")

        with engine.connect() as connection:
            assert (
                connection.execute(text("SELECT version_num FROM alembic_version")).scalar()
                == "0015"
            )
        assert reports(engine, "legacy-project", "legacy-run") is not None
    finally:
        engine.dispose()


def test_same_line_distinct_calls_keep_separate_ids():
    result = analyze({"a.py": "def f(x): return eval(eval(x))"}, "p")
    assert len({f["id"] for f in result["findings"]}) == 2
    assert len({f["fingerprint"] for f in result["findings"]}) == 2


def test_integrity_detects_corruption_missing_and_wrong_run():
    from copy import deepcopy

    from plenger.services.integrity import check_report
    from plenger.storage.runs import digest

    snapshot = {"id": "s", "project_id": "p", "files": [], "manifest_digest": digest([])}
    evidence = {"id": "e", "run_id": "r", "observed": "synthetic fact"}
    evidence["sha256_redacted"] = digest(evidence)
    report = {
        "run_id": "r",
        "snapshot_id": "s",
        "project_id": "p",
        "snapshot": snapshot,
        "manifest": {"parser": "python-ast-v2"},
        "findings": [{"snapshot_id": "s", "evidence": evidence}],
    }
    assert check_report(deepcopy(report))["findings"][0]["evidence_integrity"] == "verified"
    changed = deepcopy(report)
    changed["findings"][0]["evidence"]["observed"] = "modified"
    assert check_report(changed)["findings"][0]["evidence_integrity"] == "mismatch"
    wrong = deepcopy(report)
    wrong["run_id"] = "other"
    assert check_report(wrong)["findings"][0]["evidence_integrity"] == "mismatch"
    missing = deepcopy(report)
    del missing["findings"][0]["evidence"]
    assert check_report(missing)["findings"][0]["evidence_integrity"] == "missing"
    snapshot_bad = deepcopy(report)
    snapshot_bad["snapshot"]["files"] = ["changed"]
    assert check_report(snapshot_bad)["snapshot_integrity"] == "mismatch"
