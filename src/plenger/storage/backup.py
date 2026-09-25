"""Offline, project-bound database backups for application rollback."""

from __future__ import annotations

import hmac
import os
import re
import sqlite3
import stat
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from plenger.services.workspace import (
    WorkspaceError,
    private_directory_name,
    project_identity,
    root_fd,
)
from plenger.storage.locking import runtime_lock

_BACKUP_DIRECTORY = "migration-backups"
_BACKUP_ID = re.compile(r"^[0-9a-f]{32}$")
_BACKUP_FILE = re.compile(r"^backup-[0-9a-f]{32}\.sqlite3$")
# Backups contain evidence, so they cannot outlive the evidence retention window.
BACKUP_RETENTION_DAYS = 30
_DATABASE_NAME = "state.sqlite3"
_REQUIRED_TABLES = frozenset({"alembic_version", "projects", "reports", "runs"})


def _project_id(root: Path) -> str:
    return project_identity(root)


def _open_private_directory(root: Path) -> tuple[int, str]:
    parent = root_fd(root)
    try:
        name = private_directory_name(parent)
        private = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
    finally:
        os.close(parent)
    info = os.fstat(private)
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        os.close(private)
        raise WorkspaceError("private_directory_permissions")
    return private, name


def _open_backup_directory(private: int, *, create: bool) -> int:
    if create:
        try:
            os.mkdir(_BACKUP_DIRECTORY, 0o700, dir_fd=private)
        except FileExistsError:
            pass
    descriptor = os.open(
        _BACKUP_DIRECTORY,
        os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
        dir_fd=private,
    )
    info = os.fstat(descriptor)
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        os.close(descriptor)
        raise WorkspaceError("backup_directory_permissions")
    return descriptor


def _file_info(directory: int, name: str, *, required: bool = True) -> os.stat_result | None:
    try:
        info = os.stat(name, dir_fd=directory, follow_symlinks=False)
    except FileNotFoundError:
        if required:
            raise ValueError("database_file_not_found") from None
        return None
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_nlink != 1
        or info.st_uid != os.getuid()
        or stat.S_IMODE(info.st_mode) & 0o077
    ):
        raise WorkspaceError("unsafe_database_file")
    return info


def _open_readonly_database(path: Path, expected: os.stat_result) -> sqlite3.Connection:
    connection = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=5)
    try:
        rows = connection.execute("PRAGMA database_list").fetchall()
        database_path = next((str(row[2]) for row in rows if row[1] == "main"), "")
        current = os.stat(path, follow_symlinks=False)
        if (
            not database_path
            or Path(database_path) != path
            or (current.st_dev, current.st_ino) != (expected.st_dev, expected.st_ino)
        ):
            raise WorkspaceError("database_path_race")
        return connection
    except BaseException:
        connection.close()
        raise


def _tables(connection: sqlite3.Connection) -> set[str]:
    return {
        str(row[0])
        for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }


def _database_identity(connection: sqlite3.Connection, expected_project: str) -> str:
    tables = _tables(connection)
    if not _REQUIRED_TABLES.issubset(tables):
        raise ValueError("database_schema_unavailable")
    rows = connection.execute("SELECT version_num FROM alembic_version").fetchall()
    if len(rows) != 1 or not isinstance(rows[0][0], str):
        raise ValueError("database_schema_version_invalid")
    schema_version = rows[0][0]
    if not re.fullmatch(r"[0-9]{4}", schema_version):
        raise ValueError("database_schema_version_invalid")
    projects = connection.execute(
        "SELECT id,root_identity FROM projects WHERE id=?", (expected_project,)
    ).fetchall()
    if len(projects) != 1 or projects[0][1] != expected_project:
        raise ValueError("backup_project_mismatch")
    integrity = connection.execute("PRAGMA integrity_check").fetchone()
    if not integrity or integrity[0] != "ok":
        raise ValueError("database_integrity_check_failed")
    if connection.execute("PRAGMA foreign_key_check").fetchone() is not None:
        raise ValueError("database_foreign_key_check_failed")
    return schema_version


def prune_expired_backups(root: Path, max_age_days: int = BACKUP_RETENTION_DAYS) -> int:
    """Delete rollback snapshots older than the evidence retention window."""

    if not 1 <= max_age_days <= 3650:
        raise ValueError("invalid_backup_retention_days")
    try:
        private, _ = _open_private_directory(root)
    except (OSError, WorkspaceError):
        return 0
    removed = 0
    cutoff = time.time() - max_age_days * 86400
    try:
        try:
            directory = _open_backup_directory(private, create=False)
        except (OSError, WorkspaceError):
            return 0
        try:
            with os.scandir(directory) as entries:
                names = [entry.name for entry in entries if _BACKUP_FILE.fullmatch(entry.name)]
            for name in names:
                try:
                    info = _file_info(directory, name, required=False)
                except (ValueError, WorkspaceError):
                    continue
                if info is not None and info.st_mtime < cutoff:
                    os.unlink(name, dir_fd=directory)
                    removed += 1
        finally:
            os.close(directory)
    finally:
        os.close(private)
    return removed


def create_database_backup(root: Path) -> dict[str, str]:
    """Create a consistent, owner-only backup while the project is offline."""

    identity = _project_id(root)
    with runtime_lock(root, "server.lock"):
        with runtime_lock(root, "worker.lock"):
            with runtime_lock(root, "migration.lock"):
                private, private_name = _open_private_directory(root)
                backup_directory = -1
                source: sqlite3.Connection | None = None
                destination: sqlite3.Connection | None = None
                verification: sqlite3.Connection | None = None
                backup_id = uuid.uuid4().hex
                filename = f"backup-{backup_id}.sqlite3"
                created = False
                try:
                    info = _file_info(private, _DATABASE_NAME)
                    assert info is not None
                    private_path = root.resolve() / private_name
                    source = _open_readonly_database(private_path / _DATABASE_NAME, info)
                    schema_version = _database_identity(source, identity)
                    if source.execute(
                        "SELECT 1 FROM runs "
                        "WHERE state IN ('queued','running','cancelling') LIMIT 1"
                    ).fetchone():
                        raise ValueError("active_run_prevents_backup")
                    backup_directory = _open_backup_directory(private, create=True)
                    descriptor = os.open(
                        filename,
                        os.O_CREAT | os.O_EXCL | os.O_RDWR | os.O_NOFOLLOW,
                        0o600,
                        dir_fd=backup_directory,
                    )
                    created = True
                    try:
                        destination_path = private_path / _BACKUP_DIRECTORY / filename
                        destination = sqlite3.connect(destination_path, timeout=5)
                        source.backup(destination, pages=256, sleep=0.05)
                        destination.commit()
                        destination.execute("PRAGMA journal_mode=DELETE")
                        destination.close()
                        destination = None
                        os.fsync(descriptor)
                    finally:
                        os.close(descriptor)
                    backup_info = _file_info(backup_directory, filename)
                    assert backup_info is not None
                    verification = _open_readonly_database(
                        private_path / _BACKUP_DIRECTORY / filename, backup_info
                    )
                    verified = _database_identity(verification, identity)
                    if verified != schema_version:
                        raise ValueError("backup_schema_version_changed")
                except BaseException:
                    if created and backup_directory >= 0:
                        try:
                            os.unlink(filename, dir_fd=backup_directory)
                        except OSError:
                            pass
                    raise
                finally:
                    if destination is not None:
                        destination.close()
                    if verification is not None:
                        verification.close()
                    if source is not None:
                        source.close()
                    if backup_directory >= 0:
                        os.close(backup_directory)
                    os.close(private)
    return {
        "status": "ready",
        "backup_id": backup_id,
        "schema_version": schema_version,
        "project_id": identity,
        "created_at": datetime.now(UTC).isoformat(),
        "retention_days": str(BACKUP_RETENTION_DAYS),
    }


def _revoke_restored_authorizations(connection: sqlite3.Connection) -> dict[str, int]:
    timestamp = datetime.now(UTC).isoformat()
    counts = {"approvals_revoked": 0, "consents_revoked": 0}
    tables = _tables(connection)
    if "approvals" in tables:
        cursor = connection.execute(
            "UPDATE approvals SET revoked_at=? WHERE revoked_at IS NULL", (timestamp,)
        )
        counts["approvals_revoked"] = cursor.rowcount
    if "hosted_consents" in tables:
        cursor = connection.execute(
            "UPDATE hosted_consents SET revoked_at=? WHERE revoked_at IS NULL", (timestamp,)
        )
        counts["consents_revoked"] = cursor.rowcount
    return counts


def restore_database_backup(root: Path, backup_id: str, confirmation: str) -> dict[str, Any]:
    """Restore one same-project backup without running forward migrations."""

    identity = _project_id(root)
    if not isinstance(confirmation, str) or not hmac.compare_digest(confirmation, identity):
        raise ValueError("project_storage_confirmation_mismatch")
    if not isinstance(backup_id, str) or not _BACKUP_ID.fullmatch(backup_id):
        raise ValueError("backup_id_invalid")
    filename = f"backup-{backup_id}.sqlite3"
    with runtime_lock(root, "server.lock"):
        with runtime_lock(root, "worker.lock"):
            with runtime_lock(root, "migration.lock"):
                private, private_name = _open_private_directory(root)
                backup_directory = -1
                source: sqlite3.Connection | None = None
                restored: sqlite3.Connection | None = None
                temporary_name = f".restore-{uuid.uuid4().hex}.sqlite3"
                temporary_created = False
                database_replaced = False
                quarantined_sidecars: list[tuple[str, str]] = []
                try:
                    backup_directory = _open_backup_directory(private, create=False)
                    backup_info = _file_info(backup_directory, filename)
                    assert backup_info is not None
                    private_path = root.resolve() / private_name
                    backup_path = private_path / _BACKUP_DIRECTORY / filename
                    source = _open_readonly_database(backup_path, backup_info)
                    schema_version = _database_identity(source, identity)

                    descriptor = os.open(
                        temporary_name,
                        os.O_CREAT | os.O_EXCL | os.O_RDWR | os.O_NOFOLLOW,
                        0o600,
                        dir_fd=private,
                    )
                    temporary_created = True
                    try:
                        temporary_path = private_path / temporary_name
                        restored = sqlite3.connect(temporary_path, timeout=5)
                        source.backup(restored, pages=256, sleep=0.05)
                        restored.execute("PRAGMA journal_mode=DELETE")
                        authorization_counts = _revoke_restored_authorizations(restored)
                        restored.commit()
                        if _database_identity(restored, identity) != schema_version:
                            raise ValueError("restore_schema_version_changed")
                        restored.close()
                        restored = None
                        os.fsync(descriptor)
                    finally:
                        os.close(descriptor)
                        if restored is not None:
                            restored.close()
                            restored = None

                    current = _file_info(private, _DATABASE_NAME, required=False)
                    if current is not None:
                        latest = os.stat(_DATABASE_NAME, dir_fd=private, follow_symlinks=False)
                        if (current.st_dev, current.st_ino) != (latest.st_dev, latest.st_ino):
                            raise WorkspaceError("database_path_race")
                    for sidecar in ("state.sqlite3-wal", "state.sqlite3-shm"):
                        if _file_info(private, sidecar, required=False) is not None:
                            quarantined_name = f".restore-{uuid.uuid4().hex}-{sidecar}"
                            os.replace(
                                sidecar,
                                quarantined_name,
                                src_dir_fd=private,
                                dst_dir_fd=private,
                            )
                            quarantined_sidecars.append((sidecar, quarantined_name))
                    os.replace(
                        temporary_name,
                        _DATABASE_NAME,
                        src_dir_fd=private,
                        dst_dir_fd=private,
                    )
                    database_replaced = True
                    temporary_created = False
                    os.fsync(private)
                    for _, quarantined_name in quarantined_sidecars:
                        os.unlink(quarantined_name, dir_fd=private)
                except BaseException:
                    if temporary_created:
                        try:
                            os.unlink(temporary_name, dir_fd=private)
                        except OSError:
                            pass
                    if database_replaced:
                        for _, quarantined_name in quarantined_sidecars:
                            try:
                                os.unlink(quarantined_name, dir_fd=private)
                            except OSError:
                                pass
                    else:
                        for original_name, quarantined_name in reversed(quarantined_sidecars):
                            try:
                                os.replace(
                                    quarantined_name,
                                    original_name,
                                    src_dir_fd=private,
                                    dst_dir_fd=private,
                                )
                            except OSError:
                                raise WorkspaceError("restore_sidecar_recovery_failed") from None
                    raise
                finally:
                    if source is not None:
                        source.close()
                    if restored is not None:
                        restored.close()
                    if backup_directory >= 0:
                        os.close(backup_directory)
                    os.close(private)
    return {
        "status": "restored",
        "backup_id": backup_id,
        "schema_version": schema_version,
        "project_id": identity,
        **authorization_counts,
    }
