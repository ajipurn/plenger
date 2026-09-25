"""Local storage; target-owned paths cannot grant authorization."""

import hashlib
import json
import os
import sqlite3
import stat
from pathlib import Path
from typing import Any, cast

from sqlalchemy import create_engine, event, text
from sqlalchemy.engine import Engine

from plenger.policy import redact
from plenger.services.workspace import (
    PROJECT_ID_FILE,
    WorkspaceError,
    config_filename,
    parse_project_id,
    path_project_id,
    private_directory_name,
    read_regular_stable,
    root_fd,
)
from plenger.storage.locking import runtime_lock


def _adopt_database_identity(database_path: Path) -> str | None:
    """Recover the identity of a store created before identities were persisted.

    Such stores keyed everything by the original absolute path. If the project was
    moved, its single ``projects`` row still names that original identity.
    """

    try:
        connection = sqlite3.connect(database_path.as_uri() + "?mode=ro", uri=True, timeout=5)
    except sqlite3.Error:
        return None
    try:
        rows = connection.execute("SELECT id FROM projects LIMIT 2").fetchall()
    except sqlite3.Error:
        return None
    finally:
        connection.close()
    if len(rows) != 1 or not isinstance(rows[0][0], str):
        return None
    try:
        return parse_project_id(rows[0][0].encode())
    except WorkspaceError:
        return None


def _project_identity_in(private: int, root: Path, private_name: str) -> str:
    """Read, adopt, or create the identity that travels with the private directory."""

    try:
        return parse_project_id(read_regular_stable(private, PROJECT_ID_FILE, 128))
    except FileNotFoundError:
        pass
    identity: str | None = None
    try:
        existing = os.stat("state.sqlite3", dir_fd=private, follow_symlinks=False)
    except FileNotFoundError:
        existing = None
    if existing is not None and existing.st_size > 0:
        identity = _adopt_database_identity(root.resolve() / private_name / "state.sqlite3")
    identity = identity or path_project_id(root)
    try:
        descriptor = os.open(
            PROJECT_ID_FILE,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600,
            dir_fd=private,
        )
    except FileExistsError:
        return parse_project_id(read_regular_stable(private, PROJECT_ID_FILE, 128))
    try:
        os.write(descriptor, (identity + "\n").encode())
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    return identity


def _database_marker(identity: str) -> int:
    return (int(identity[:8], 16) & 0x7FFFFFFF) or 1


def open_store(root: Path) -> Engine:
    database_identity: tuple[int, int] | None = None
    # Keep the original inode pinned until SQLite has completed its first migration.
    database_fd = -1
    root_identity = ""
    root_handle = root_fd(root)
    try:
        private_name = private_directory_name(root_handle)
        try:
            os.mkdir(private_name, 0o700, dir_fd=root_handle)
        except FileExistsError:
            pass
        private = os.open(
            private_name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_handle
        )
        try:
            info = os.fstat(private)
            if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
                raise WorkspaceError("private_directory_permissions")
            for filename in ("state.sqlite3", "state.sqlite3-wal", "state.sqlite3-shm"):
                try:
                    existing = os.stat(filename, dir_fd=private, follow_symlinks=False)
                    if (
                        not stat.S_ISREG(existing.st_mode)
                        or existing.st_nlink != 1
                        or existing.st_uid != os.getuid()
                    ):
                        raise WorkspaceError("unsafe_database_file")
                except FileNotFoundError:
                    pass
            root_identity = _project_identity_in(private, root, private_name)
            fd = os.open(
                "state.sqlite3", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600, dir_fd=private
            )
            try:
                opened = os.fstat(fd)
                if (
                    not stat.S_ISREG(opened.st_mode)
                    or opened.st_nlink != 1
                    or opened.st_uid != os.getuid()
                ):
                    raise WorkspaceError("unsafe_database_file")
                database_identity = (opened.st_dev, opened.st_ino)
                os.fchmod(fd, 0o600)
                database_fd = fd
                fd = -1
            finally:
                if fd >= 0:
                    os.close(fd)
        finally:
            os.close(private)
    finally:
        os.close(root_handle)
    if database_identity is None or not root_identity:
        raise WorkspaceError("unsafe_database_file")
    database_marker = _database_marker(root_identity)
    database_path = root.resolve() / private_name / "state.sqlite3"
    try:
        engine = create_engine("sqlite:///" + str(database_path))
    except Exception:
        if database_fd >= 0:
            os.close(database_fd)
        raise
    marker_initialized = False

    def assert_database_identity(connection: Any, *, initialize_marker: bool = False) -> None:
        cursor = connection.cursor()
        try:
            database_rows = cursor.execute("PRAGMA database_list").fetchall()
            database_name = next(
                (str(row[2]) for row in database_rows if row[1] == "main" and row[2]), None
            )
            if database_name is None:
                raise WorkspaceError("database_path_missing")
            try:
                current = os.stat(database_name, follow_symlinks=False)
            except OSError:
                raise WorkspaceError("database_path_race") from None
            if (
                not stat.S_ISREG(current.st_mode)
                or current.st_nlink != 1
                or current.st_uid != os.getuid()
                or (current.st_dev, current.st_ino) != database_identity
            ):
                raise WorkspaceError("database_path_race")
            application_id = cursor.execute("PRAGMA application_id").fetchone()
            if not application_id or not isinstance(application_id[0], int):
                raise WorkspaceError("database_path_race")
            if application_id[0] == 0 and initialize_marker:
                cursor.execute(f"PRAGMA application_id = {database_marker}")
            elif application_id[0] != database_marker:
                raise WorkspaceError("database_path_race")
        finally:
            cursor.close()

    @event.listens_for(engine, "connect")
    def configure(connection: Any, record: Any) -> None:
        nonlocal marker_initialized
        del record
        assert_database_identity(connection, initialize_marker=not marker_initialized)
        marker_initialized = True
        cursor = connection.cursor()
        try:
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.execute("PRAGMA journal_mode=WAL")
            cursor.execute("PRAGMA busy_timeout=5000")
        finally:
            cursor.close()

    @event.listens_for(engine, "checkout")
    def validate_checkout(connection: Any, record: Any, proxy: Any) -> None:
        del record, proxy
        assert_database_identity(connection)

    try:
        from alembic import command
        from alembic.config import Config

        config = Config()
        config.set_main_option("script_location", str(Path(__file__).parent / "migrations"))
        with runtime_lock(root, "migration.lock", blocking=True):
            with engine.begin() as connection:
                config.attributes["connection"] = connection
                command.upgrade(config, "head")
    finally:
        if database_fd >= 0:
            os.close(database_fd)
    project_name = root.name[:128] or "plenger project"
    try:
        descriptor = root_fd(root)
        try:
            config_hash = hashlib.sha256(
                read_regular_stable(descriptor, config_filename(descriptor), 16384)
            ).hexdigest()
        finally:
            os.close(descriptor)
    except (OSError, WorkspaceError):
        config_hash = "unknown"
    with engine.begin() as connection:
        connection.execute(
            text(
                "INSERT OR IGNORE INTO projects "
                "(id,created_at,content_key,name,root_identity,config_hash) "
                "VALUES (:id,:created,:key,:name,:root,:config)"
            ),
            {
                "id": root_identity,
                "created": now_text(),
                "key": os.urandom(32),
                "name": project_name,
                "root": root_identity,
                "config": config_hash,
            },
        )
        connection.execute(
            text(
                "UPDATE projects SET name=:name,root_identity=:root,config_hash=:config "
                "WHERE id=:id"
            ),
            {
                "id": root_identity,
                "name": project_name,
                "root": root_identity,
                "config": config_hash,
            },
        )
    from plenger.storage.retention import purge_expired_metadata

    purge_expired_metadata(engine, root_identity)
    return engine


def now_text() -> str:
    """Avoid importing run-ledger helpers into storage initialization."""

    from datetime import UTC, datetime

    return datetime.now(UTC).isoformat()


def save_report(engine: Engine, report: dict[str, Any]) -> None:
    safe_report = redact(report)
    with engine.begin() as connection:
        connection.execute(
            text("INSERT INTO reports (id, project_id, payload) VALUES (:id,:p,:v)"),
            {
                "id": safe_report["run_id"],
                "p": safe_report["project_id"],
                "v": json.dumps(safe_report),
            },
        )


def reports(
    engine: Engine, project_id: str, run_id: str | None = None, *, redacted: bool = True
) -> dict[str, Any] | None:
    """Load one report. ``redacted=False`` is only for integrity checks before output."""

    query = "SELECT payload FROM reports WHERE project_id=:p"
    args = {"p": project_id}
    if run_id is not None:
        query += " AND id=:id"
        args["id"] = run_id
    query += " ORDER BY rowid DESC LIMIT 1"
    with engine.connect() as connection:
        row = connection.execute(text(query), args).first()
    if not row:
        return None
    payload: dict[str, Any] = json.loads(row[0])
    return cast(dict[str, Any], redact(payload)) if redacted else payload


def latest_report_id(engine: Engine, project_id: str) -> str | None:
    """Return the newest report identity without loading its JSON payload."""

    with engine.connect() as connection:
        value = connection.execute(
            text("SELECT id FROM reports WHERE project_id=:p ORDER BY rowid DESC LIMIT 1"),
            {"p": project_id},
        ).scalar_one_or_none()
    return str(value) if value is not None else None
