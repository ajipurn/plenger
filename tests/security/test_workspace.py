import os
import sqlite3
import threading

import pytest

from plenger.domain.config import ProjectConfig
from plenger.services.workspace import (
    WorkspaceError,
    capture,
    initialize,
    load_config,
    open_directory_stable,
    parse_config,
    read_regular,
    root_fd,
)


@pytest.mark.parametrize(
    "payload",
    [
        b"schema_version: 1\nschema_version: 1",
        b"a: &a [1]\nb: *a",
        b'!!python/object/apply:os.system ["touch bad"]',
        b"command: echo unsafe",
        b"active: true",
        b"hosted_consent: true",
        b"environment: production",
        b'max_files: "4"',
        b"profile: arbitrary",
        b"schema_version: 2",
        b"schema_version: true",
        b"[]",
        b"a: " + b"[" * 20 + b"]" * 20,
        b"x" * 16385,
    ],
)
def test_unsafe_config_rejected(payload):
    with pytest.raises(WorkspaceError):
        parse_config(payload)


def test_init_idempotent_does_not_execute_or_overwrite(tmp_path):
    sentinel = tmp_path / "executed"
    (tmp_path / "setup.py").write_text(f'open({str(sentinel)!r}, "w").write("bad")')
    (tmp_path / ".gitignore").write_text("user-content\n")
    assert initialize(tmp_path)
    original = (tmp_path / "plenger.yaml").read_bytes()
    assert not initialize(tmp_path)
    assert (tmp_path / "plenger.yaml").read_bytes() == original
    assert (tmp_path / ".gitignore").read_text() == "user-content\n"
    assert not sentinel.exists()
    assert load_config(tmp_path).profile == "deterministic"


def test_capture_skips_symlinks_devices_and_sensitive_files(tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    outside = tmp_path / "outside.py"
    outside.write_text('secret = "not-readable"')
    (root / "link.py").symlink_to(outside)
    (root / "dir").symlink_to(tmp_path, target_is_directory=True)
    os.mkfifo(root / "fifo.py")
    (root / ".env.py").write_text("secret")
    (root / "ok.py").write_text("def hello(): pass")
    files, skipped = capture(root, ProjectConfig())
    assert files == {"ok.py": "def hello(): pass"}
    assert {s["reason"] for s in skipped} == {"symlink", "not_regular", "excluded"}


def test_capture_scanner_mode_includes_supported_text_without_changing_parser_default(tmp_path):
    (tmp_path / "code.py").write_text("value = eval(input())")
    (tmp_path / "secrets.txt").write_text("token = synthetic")
    (tmp_path / "uv.lock").write_text("version = 1")
    (tmp_path / "image.bin").write_bytes(b"\x00\x01")

    parser_files, _ = capture(tmp_path, ProjectConfig())
    scanner_files, scanner_skipped = capture(tmp_path, ProjectConfig(), include_scanner_inputs=True)

    assert parser_files == {"code.py": "value = eval(input())"}
    assert scanner_files["secrets.txt"] == "token = synthetic"
    assert scanner_files["uv.lock"] == "version = 1"
    assert "image.bin" in {item["path"] for item in scanner_skipped}


@pytest.mark.parametrize("path", ["../outside", "/etc/passwd", ".", "dir/file", "dir\\file"])
def test_descriptor_path_escape_rejected(tmp_path, path):
    fd = root_fd(tmp_path)
    try:
        with pytest.raises(WorkspaceError):
            read_regular(fd, path, 100)
    finally:
        os.close(fd)


def test_read_regular_rejects_inode_replacement(tmp_path):
    target = tmp_path / "captured.py"
    target.write_text("original\n")
    identity = (target.stat().st_dev, target.stat().st_ino)
    replacement = tmp_path / "replacement.py"
    replacement.write_text("replacement\n")
    replacement.replace(target)
    fd = root_fd(tmp_path)
    try:
        with pytest.raises(WorkspaceError, match="not_regular_or_too_large"):
            read_regular(fd, "captured.py", 100, expected_identity=identity)
    finally:
        os.close(fd)


def test_open_directory_rejects_inode_replacement(tmp_path):
    nested = tmp_path / "nested"
    nested.mkdir()
    original_identity = (nested.stat().st_dev, nested.stat().st_ino)
    replacement = tmp_path / "replacement"
    replacement.mkdir()
    nested.rename(tmp_path / "old-nested")
    replacement.rename(nested)
    fd = root_fd(tmp_path)
    try:
        with pytest.raises(WorkspaceError, match="directory_changed"):
            open_directory_stable(fd, "nested", original_identity)
    finally:
        os.close(fd)


def test_capture_rejects_file_swap_between_stat_and_open(tmp_path, monkeypatch):
    from plenger.services import workspace

    root = tmp_path / "root"
    root.mkdir()
    target = root / "target.py"
    target.write_text("safe = True\n")
    outside = tmp_path / "outside.py"
    outside.write_text("secret = 'outside'\n")
    original_read_regular = workspace.read_regular

    def swap_before_open(directory, name, limit, *, expected_identity=None):
        if name == "target.py":
            replacement = root / "replacement.py"
            os.link(outside, replacement)
            os.replace(replacement, target)
        return original_read_regular(directory, name, limit, expected_identity=expected_identity)

    monkeypatch.setattr(workspace, "read_regular", swap_before_open)
    with pytest.raises(WorkspaceError, match="not_regular_or_too_large"):
        capture(root, ProjectConfig())


def test_read_regular_rejects_directory_entry_swap_after_open(tmp_path, monkeypatch):
    from plenger.services import workspace

    target = tmp_path / "target.py"
    target.write_text("safe = True\n")
    outside = tmp_path / "outside.py"
    outside.write_text("secret = 'outside'\n")
    identity = (target.stat().st_dev, target.stat().st_ino)
    directory = root_fd(tmp_path)
    original_fstat = os.fstat
    swapped = False

    def swap_after_open(descriptor):
        nonlocal swapped
        info = original_fstat(descriptor)
        if descriptor != directory and not swapped:
            replacement = tmp_path / "replacement.py"
            os.link(outside, replacement)
            os.replace(replacement, target)
            swapped = True
        return info

    monkeypatch.setattr(workspace.os, "fstat", swap_after_open)
    try:
        with pytest.raises(WorkspaceError, match="file_changed_or_too_large"):
            read_regular(directory, "target.py", 100, expected_identity=identity)
    finally:
        os.close(directory)


def test_capture_rejects_directory_swap_between_stat_and_open(tmp_path, monkeypatch):
    from plenger.services import workspace

    root = tmp_path / "root"
    root.mkdir()
    nested = root / "nested"
    nested.mkdir()
    (nested / "safe.py").write_text("safe = True\n")
    replacement = tmp_path / "replacement"
    replacement.mkdir()
    original_open_directory = workspace.open_directory_stable

    def swap_before_open(directory, name, expected_identity):
        if name == "nested":
            nested.rename(tmp_path / "old-nested")
            replacement.rename(nested)
        return original_open_directory(directory, name, expected_identity)

    monkeypatch.setattr(workspace, "open_directory_stable", swap_before_open)
    with pytest.raises(WorkspaceError, match="directory_changed"):
        capture(root, ProjectConfig())


def test_capture_concurrent_same_uid_replacement_never_returns_external_payload(tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    private = root / ".plenger"
    private.mkdir()
    target = root / "target.py"
    target.write_text("safe = True\n")
    outside = tmp_path / "outside.py"
    outside.write_text("secret = 'outside'\n")
    stop = threading.Event()
    swap_errors: list[OSError] = []

    def swap_target() -> None:
        use_external = False
        while not stop.is_set():
            replacement = private / "swap.py"
            try:
                if use_external:
                    os.link(outside, replacement)
                else:
                    replacement.write_text("safe = True\n")
                os.replace(replacement, target)
                use_external = not use_external
            except FileNotFoundError:
                continue
            except OSError as exc:
                if not stop.is_set():
                    swap_errors.append(exc)

    worker = threading.Thread(target=swap_target, daemon=True)
    worker.start()
    observed: list[str] = []
    try:
        for _ in range(50):
            try:
                files, _ = capture(root, ProjectConfig())
            except (OSError, WorkspaceError):
                continue
            observed.extend(files.values())
    finally:
        stop.set()
        worker.join()

    assert not swap_errors
    external_payloads = [source for source in observed if "outside" in source]
    assert not external_payloads, external_payloads[:3]


def test_config_symlink_rejected(tmp_path):
    (tmp_path / "plenger.yaml").symlink_to("/etc/passwd")
    with pytest.raises(OSError):
        load_config(tmp_path)


def test_size_limit_skips_file_without_aborting_capture(tmp_path):
    (tmp_path / "big.py").write_text("x" * 30)
    (tmp_path / "small.py").write_text("x = 1\n")
    files, skipped = capture(tmp_path, ProjectConfig(max_file_bytes=10))
    assert files == {"small.py": "x = 1\n"}
    assert {"path": "big.py", "reason": "too_large"} in skipped


def test_per_file_limit_can_be_raised_explicitly(tmp_path):
    assert ProjectConfig(max_file_bytes=16 * 1024 * 1024, max_files=200000).max_file_bytes
    with pytest.raises(ValueError):
        ProjectConfig(max_file_bytes=16 * 1024 * 1024 + 1)


def test_private_storage_symlink_rejected(tmp_path):
    from plenger.storage.database import open_store

    (tmp_path / ".plenger").symlink_to(tmp_path, target_is_directory=True)
    with pytest.raises(OSError):
        open_store(tmp_path)


def test_hardlinked_file_rejected(tmp_path):
    outside = tmp_path / "outside.py"
    outside.write_text("private data")
    root = tmp_path / "root"
    root.mkdir()
    os.link(outside, root / "copy.py")
    (root / "own.py").write_text("own = True\n")
    files, skipped = capture(root, ProjectConfig())
    assert files == {"own.py": "own = True\n"}
    assert {"path": "copy.py", "reason": "hardlink"} in skipped
    assert all("private data" not in source for source in files.values())


def test_existing_engine_rejects_database_replacement(tmp_path):
    from plenger.storage.database import open_store

    initialize(tmp_path)
    engine = open_store(tmp_path)
    database = tmp_path / ".plenger" / "state.sqlite3"
    engine.dispose()
    for sidecar in (
        database.with_name("state.sqlite3-wal"),
        database.with_name("state.sqlite3-shm"),
    ):
        sidecar.unlink(missing_ok=True)
    database.unlink()
    replacement = sqlite3.connect(database)
    replacement.close()
    os.chmod(database, 0o600)
    try:
        with pytest.raises(WorkspaceError, match="database_path_race"):
            with engine.connect():
                pass
    finally:
        engine.dispose()


def test_store_rejects_database_replacement_before_first_connection(tmp_path, monkeypatch):
    from plenger.storage import database as storage

    initialize(tmp_path)
    database = tmp_path / ".plenger" / "state.sqlite3"
    sidecars = (
        database.with_name("state.sqlite3-wal"),
        database.with_name("state.sqlite3-shm"),
    )
    original_create_engine = storage.create_engine

    def swap_before_connect(url):
        database.rename(database.with_name("state.sqlite3.original"))
        for sidecar in sidecars:
            sidecar.unlink(missing_ok=True)
        replacement = sqlite3.connect(database)
        replacement.close()
        os.chmod(database, 0o600)
        return original_create_engine(url)

    monkeypatch.setattr(storage, "create_engine", swap_before_connect)
    with pytest.raises(WorkspaceError, match="database_path_race"):
        storage.open_store(tmp_path)


def test_pooled_engine_rejects_database_replacement_on_checkout(tmp_path):
    from plenger.storage.database import open_store

    initialize(tmp_path)
    engine = open_store(tmp_path)
    database = tmp_path / ".plenger" / "state.sqlite3"
    with engine.connect() as connection:
        connection.exec_driver_sql("SELECT 1")
    database.rename(database.with_name("state.sqlite3.old"))
    replacement = sqlite3.connect(database)
    replacement.close()
    os.chmod(database, 0o600)
    try:
        with pytest.raises(WorkspaceError, match="database_path_race"):
            with engine.connect():
                pass
    finally:
        engine.dispose()


def test_documented_yaml_examples_match_implemented_schema():
    from pathlib import Path

    root = Path(__file__).parents[2]
    for name in ("plenger.example.yaml", "plenger.minimal.yaml"):
        assert parse_config((root / "examples" / name).read_bytes()).profile == "deterministic"
