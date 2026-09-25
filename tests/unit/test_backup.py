import json
import sqlite3
import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import text
from typer.testing import CliRunner

from plenger.cli.main import app
from plenger.services.application import project_id
from plenger.services.workspace import initialize
from plenger.storage.backup import create_database_backup, restore_database_backup
from plenger.storage.database import open_store
from plenger.storage.locking import StoreBusy, runtime_lock


def _seed_database(root):
    initialize(root)
    engine = open_store(root)
    identity = project_id(root)
    created_at = datetime.now(UTC).isoformat()
    plan_id = str(uuid.uuid4())
    approval_id = str(uuid.uuid4())
    consent_id = str(uuid.uuid4())
    with engine.begin() as connection:
        connection.execute(
            text("INSERT INTO reports (id,project_id,payload) VALUES (:id,:project,:payload)"),
            {"id": str(uuid.uuid4()), "project": identity, "payload": '{"version":"before"}'},
        )
        connection.execute(
            text(
                "INSERT INTO plans (id,project_id,snapshot_digest,plan_digest,scope_digest,"
                "profile,payload,state,revision,created_at,updated_at) VALUES "
                "(:id,:project,:snapshot,:digest,:scope,:profile,:payload,:state,0,:created,:created)"
            ),
            {
                "id": plan_id,
                "project": identity,
                "snapshot": "a" * 64,
                "digest": "b" * 64,
                "scope": "c" * 64,
                "profile": "test",
                "payload": "{}",
                "state": "approved",
                "created": created_at,
            },
        )
        connection.execute(
            text(
                "INSERT INTO approvals (id,plan_id,project_id,plan_digest,scope_digest,actor,"
                "expires_at,consumed_at,revoked_at,created_at) VALUES "
                "(:id,:plan,:project,:digest,:scope,:actor,:expires,NULL,NULL,:created)"
            ),
            {
                "id": approval_id,
                "plan": plan_id,
                "project": identity,
                "digest": "b" * 64,
                "scope": "c" * 64,
                "actor": "backup-test",
                "expires": "2999-01-01T00:00:00+00:00",
                "created": created_at,
            },
        )
        connection.execute(
            text(
                "INSERT INTO hosted_consents (id,project_id,config_hash,provider,data_classes,"
                "domain,actor,created_at,revoked_at) VALUES "
                "(:id,:project,:config,:provider,:classes,:domain,:actor,:created,NULL)"
            ),
            {
                "id": consent_id,
                "project": identity,
                "config": "d" * 64,
                "provider": "jev",
                "classes": '["metadata"]',
                "domain": "api.typesafe.ai",
                "actor": "backup-test",
                "created": created_at,
            },
        )
    engine.dispose()
    return identity


def test_cli_backup_and_restore_preserves_data_and_revokes_authorization(tmp_path):
    identity = _seed_database(tmp_path)
    runner = CliRunner()

    backup = runner.invoke(app, ["backup", "--project", str(tmp_path)])
    assert backup.exit_code == 0, backup.stdout
    backup_payload = json.loads(backup.stdout)
    assert backup_payload["schema_version"] == "0015"

    engine = open_store(tmp_path)
    with engine.begin() as connection:
        connection.execute(
            text("UPDATE reports SET payload=:payload"),
            {"payload": '{"version":"after"}'},
        )
        connection.execute(text("UPDATE approvals SET consumed_at='later'"))
        connection.execute(text("UPDATE hosted_consents SET revoked_at=NULL"))
    engine.dispose()

    restored = runner.invoke(
        app,
        [
            "restore",
            backup_payload["backup_id"],
            "--project",
            str(tmp_path),
            "--confirm-project-id",
            identity,
        ],
    )
    assert restored.exit_code == 0, restored.stdout
    restored_payload = json.loads(restored.stdout)
    assert restored_payload["status"] == "restored"
    assert restored_payload["approvals_revoked"] == 1
    assert restored_payload["consents_revoked"] == 1

    connection = sqlite3.connect(tmp_path / ".plenger" / "state.sqlite3")
    try:
        assert connection.execute("SELECT payload FROM reports").fetchone()[0] == (
            '{"version":"before"}'
        )
        assert connection.execute("SELECT revoked_at FROM approvals").fetchone()[0]
        assert connection.execute("SELECT revoked_at FROM hosted_consents").fetchone()[0]
        assert connection.execute("SELECT version_num FROM alembic_version").fetchone()[0] == (
            "0015"
        )
        assert connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    finally:
        connection.close()


def test_restore_requires_project_confirmation_and_safe_backup_id(tmp_path):
    identity = _seed_database(tmp_path)
    backup = create_database_backup(tmp_path)

    with pytest.raises(ValueError, match="confirmation_mismatch"):
        restore_database_backup(tmp_path, backup["backup_id"], "another-project")
    with pytest.raises(ValueError, match="backup_id_invalid"):
        restore_database_backup(tmp_path, "../state.sqlite3", identity)


def test_database_backup_requires_project_to_be_offline(tmp_path):
    identity = _seed_database(tmp_path)
    backup = create_database_backup(tmp_path)

    for lock_name in ("server.lock", "worker.lock", "migration.lock"):
        with runtime_lock(tmp_path, lock_name):
            with pytest.raises(StoreBusy, match="project_worker_busy"):
                create_database_backup(tmp_path)
            with pytest.raises(StoreBusy, match="project_worker_busy"):
                restore_database_backup(tmp_path, backup["backup_id"], identity)


def test_backups_older_than_evidence_retention_are_pruned(tmp_path):
    import os
    import time

    from plenger.storage.backup import prune_expired_backups

    _seed_database(tmp_path)
    old = create_database_backup(tmp_path)
    recent = create_database_backup(tmp_path)
    directory = tmp_path / ".plenger" / "migration-backups"
    old_path = directory / f"backup-{old['backup_id']}.sqlite3"
    stale = time.time() - 31 * 86400
    os.utime(old_path, (stale, stale))
    (directory / "notes.txt").write_text("not a managed backup")

    assert prune_expired_backups(tmp_path) == 1
    assert not old_path.exists()
    assert (directory / f"backup-{recent['backup_id']}.sqlite3").exists()
    assert (directory / "notes.txt").exists()
