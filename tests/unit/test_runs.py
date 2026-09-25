from concurrent.futures import ThreadPoolExecutor

import pytest
from sqlalchemy import text

from plenger.domain import RunState
from plenger.services.application import (
    execute_scan,
    project_id,
    queue_scan,
    recover_runs,
    run_history,
    run_status,
)
from plenger.services.snapshot import manifest
from plenger.services.workspace import initialize
from plenger.storage import open_store
from plenger.storage.locking import StoreBusy, runtime_lock
from plenger.storage.runs import (
    RunConflict,
    advance,
    claim_lease,
    create_run,
    heartbeat_lease,
    list_events,
    release_lease,
)


def test_atomic_idempotency_and_conflicting_body(tmp_path):
    initialize(tmp_path)
    engine = open_store(tmp_path)

    def submit(_):
        return create_run(engine, "p", "deterministic", False, "digest", "same-key")

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(submit, range(8)))
    assert len({result[0] for result in results}) == 1
    assert sum(created for _, created in results) == 1
    with pytest.raises(RunConflict, match="idempotency_conflict"):
        create_run(engine, "p", "baseline", False, "digest", "same-key")
    engine.dispose()


def test_config_changed_after_queue_is_blocked(tmp_path):
    initialize(tmp_path)
    run_id, _ = queue_scan(tmp_path, "deterministic", False, "key")
    (tmp_path / "plenger.yaml").write_text("schema_version: 1\nmax_files: 2\n")
    with pytest.raises(RunConflict, match="config_changed"):
        execute_scan(tmp_path, run_id)
    assert run_status(tmp_path, run_id)["state"] == "blocked"


def test_recovery_keeps_evidence_and_never_replays(tmp_path):
    initialize(tmp_path)
    run_id, _ = queue_scan(tmp_path, "deterministic", False, "key")
    engine = open_store(tmp_path)
    with engine.begin() as connection:
        advance(connection, project_id(tmp_path), run_id, RunState.RUNNING)
    engine.dispose()
    assert recover_runs(tmp_path) == 1
    assert run_status(tmp_path, run_id)["state"] == "interrupted"
    with pytest.raises(RunConflict, match="run_not_queued"):
        execute_scan(tmp_path, run_id)
    engine = open_store(tmp_path)
    with engine.connect() as connection:
        states = (
            connection.execute(
                text("SELECT state FROM run_events WHERE run_id=:id ORDER BY sequence"),
                {"id": run_id},
            )
            .scalars()
            .all()
        )
        assert states == ["queued", "running", "interrupted"]
        assert connection.execute(text("SELECT COUNT(*) FROM reports")).scalar() == 0
    engine.dispose()


def test_startup_recovery_interrupts_queued_run_without_replay(tmp_path):
    initialize(tmp_path)
    run_id, _ = queue_scan(tmp_path, "deterministic", False, "queued-recovery")

    assert recover_runs(tmp_path) == 1
    assert run_status(tmp_path, run_id)["state"] == "interrupted"
    with pytest.raises(RunConflict, match="run_not_queued"):
        execute_scan(tmp_path, run_id)

    engine = open_store(tmp_path)
    try:
        with engine.connect() as connection:
            states = (
                connection.execute(
                    text("SELECT state FROM run_events WHERE run_id=:id ORDER BY sequence"),
                    {"id": run_id},
                )
                .scalars()
                .all()
            )
            assert states == ["queued", "interrupted"]
            assert connection.execute(text("SELECT COUNT(*) FROM reports")).scalar() == 0
    finally:
        engine.dispose()


def test_live_lock_prevents_recovery(tmp_path):
    initialize(tmp_path)
    run_id, _ = queue_scan(tmp_path, "deterministic", False, "key")
    with runtime_lock(tmp_path):
        assert recover_runs(tmp_path) == 0
        with pytest.raises(StoreBusy):
            with runtime_lock(tmp_path):
                pass
    assert run_status(tmp_path, run_id)["state"] == "queued"


def test_queue_is_bounded(tmp_path):
    initialize(tmp_path)
    queue_scan(tmp_path, "deterministic", False, "one")
    queue_scan(tmp_path, "deterministic", False, "two")
    with pytest.raises(RunConflict, match="queue_capacity"):
        queue_scan(tmp_path, "deterministic", False, "three")


def test_run_lease_is_atomic_and_owner_bound(tmp_path):
    initialize(tmp_path)
    run_id, _ = queue_scan(tmp_path, "deterministic", False, "lease")
    identity = project_id(tmp_path)
    engine = open_store(tmp_path)
    try:
        with engine.begin() as connection:
            claim_lease(connection, identity, run_id, "worker-a")
            heartbeat_lease(connection, identity, run_id, "worker-a")
        with pytest.raises(RunConflict, match="lease_owned_or_run_unavailable"):
            with engine.begin() as connection:
                claim_lease(connection, identity, run_id, "worker-b")
        with engine.begin() as connection:
            release_lease(connection, identity, run_id, "worker-b")
            release_lease(connection, identity, run_id, "worker-a")
            claim_lease(connection, identity, run_id, "worker-b")
    finally:
        engine.dispose()


def test_snapshot_identity_changes_with_source_and_project():
    first = manifest({"a.py": 'secret = "synthetic"'}, [], b"a" * 32, "project-a")
    same = manifest({"a.py": 'secret = "synthetic"'}, [], b"a" * 32, "project-a")
    changed = manifest({"a.py": 'secret = "changed"'}, [], b"a" * 32, "project-a")
    other = manifest({"a.py": 'secret = "synthetic"'}, [], b"b" * 32, "project-b")
    assert first["manifest_digest"] == same["manifest_digest"]
    assert first["id"] != same["id"]
    assert first["manifest_digest"] != changed["manifest_digest"] != other["manifest_digest"]
    assert "synthetic" not in str(first)


def test_snapshot_captures_git_metadata_when_available(tmp_path, monkeypatch):
    from plenger.services import snapshot

    monkeypatch.setattr(snapshot, "_git_metadata", lambda root: ("a" * 40, True))
    result = manifest({"a.py": "value = 1"}, [], b"a" * 32, "project-a", root=tmp_path)

    assert result["commit"] == "a" * 40
    assert result["dirty"] is True
    assert all("Git" not in limitation for limitation in result["limitations"])


def test_git_metadata_reports_commit_and_dirty_state(tmp_path):
    import os
    import re
    import shutil
    import subprocess

    from plenger.services.snapshot import _git_metadata

    git = shutil.which("git")
    if git is None:
        pytest.skip("git is unavailable")
    environment = {
        "PATH": "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_TERMINAL_PROMPT": "0",
        "LC_ALL": "C",
    }
    command = [git, "-C", str(tmp_path)]
    subprocess.run([*command, "init", "--quiet"], env=environment, check=True)
    subprocess.run(
        [*command, "config", "user.email", "test@plenger.invalid"],
        env=environment,
        check=True,
    )
    subprocess.run([*command, "config", "user.name", "plenger Test"], env=environment, check=True)
    (tmp_path / "a.py").write_text("value = 1\n")
    subprocess.run([*command, "add", "a.py"], env=environment, check=True)
    subprocess.run(
        [*command, "commit", "--quiet", "--no-gpg-sign", "-m", "fixture"],
        env=environment,
        check=True,
    )

    commit, dirty = _git_metadata(tmp_path)
    assert commit is not None and re.fullmatch(r"[0-9a-f]{40}", commit)
    assert dirty is False

    (tmp_path / "a.py").write_text("value = 2\n")
    assert _git_metadata(tmp_path)[1] is True


def test_worker_failure_persists_safe_reason(tmp_path, monkeypatch):
    from plenger import adapters
    from plenger.services import application

    initialize(tmp_path)
    run_id, _ = queue_scan(tmp_path, "deterministic", False, "key")
    monkeypatch.setattr(application, "probe", lambda: {"status": "unavailable"})
    with pytest.raises(adapters.SandboxError):
        execute_scan(tmp_path, run_id)
    status = run_status(tmp_path, run_id)
    assert status["state"] == "failed" and status["reason"] == "sandbox_unavailable"


def test_run_reason_readers_redact_tampered_metadata(tmp_path):
    initialize(tmp_path)
    run_id, _ = queue_scan(tmp_path, "deterministic", False, "run-reason-boundary")
    identity = project_id(tmp_path)
    marker = "sk-synthetic-run-secret123456"
    engine = open_store(tmp_path)
    try:
        with engine.begin() as connection:
            connection.execute(
                text("UPDATE runs SET reason=:reason WHERE id=:run"),
                {"reason": marker, "run": run_id},
            )
            connection.execute(
                text("UPDATE run_events SET reason=:reason WHERE run_id=:run AND sequence=0"),
                {"reason": marker, "run": run_id},
            )
        events = list_events(engine, identity, run_id)
    finally:
        engine.dispose()

    assert run_status(tmp_path, run_id)["reason"] == "[REDACTED]"
    assert run_history(tmp_path)[0]["reason"] == "[REDACTED]"
    assert events[0]["reason"] == "[REDACTED]"


def test_recovery_cleanup_failure_blocks_new_worker(tmp_path, monkeypatch):
    from plenger.adapters import SandboxError
    from plenger.services import application

    initialize(tmp_path)
    old, _ = queue_scan(tmp_path, "deterministic", False, "old")
    engine = open_store(tmp_path)
    with engine.begin() as connection:
        advance(connection, project_id(tmp_path), old, RunState.RUNNING)
    engine.dispose()
    monkeypatch.setattr(application, "cleanup_run", lambda run_id: False)
    assert recover_runs(tmp_path) == 1
    assert run_status(tmp_path, old)["reason"] == "orphan_cleanup_pending"
    new, _ = queue_scan(tmp_path, "deterministic", False, "new")
    with pytest.raises(SandboxError, match="orphan_cleanup_pending"):
        execute_scan(tmp_path, new)
    assert run_status(tmp_path, new)["state"] == "blocked"


def test_remote_docker_context_is_rejected(monkeypatch):
    import subprocess

    from plenger import adapters

    monkeypatch.setattr(adapters.shutil, "which", lambda name: "/trusted/docker")
    calls = []

    def remote(argv, **kwargs):
        calls.append(argv)
        return subprocess.CompletedProcess(argv, 0, stdout=b"ssh://remote.example\n")

    monkeypatch.setattr(adapters.subprocess, "run", remote)
    assert adapters.probe() == {"status": "unavailable", "reason": "remote_docker_forbidden"}
    assert len(calls) == 1 and calls[0][1:3] == ["context", "inspect"]


def test_recovery_cleanup_retry_is_audited(tmp_path, monkeypatch):
    from plenger.services import application

    initialize(tmp_path)
    run_id, _ = queue_scan(tmp_path, "deterministic", False, "key")
    engine = open_store(tmp_path)
    with engine.begin() as connection:
        advance(connection, project_id(tmp_path), run_id, RunState.RUNNING)
    monkeypatch.setattr(application, "cleanup_run", lambda run: False)
    recover_runs(tmp_path)
    monkeypatch.setattr(application, "cleanup_run", lambda run: True)
    recover_runs(tmp_path)
    current = run_status(tmp_path, run_id)
    assert current["state"] == "interrupted" and current["reason"] == "process_interrupted"
    with engine.connect() as connection:
        events = connection.execute(
            text("SELECT sequence,reason FROM run_events WHERE run_id=:id ORDER BY sequence"),
            {"id": run_id},
        ).all()
        assert [row[0] for row in events] == [0, 1, 2, 3]
        assert events[-1][1] == "orphan_cleanup_completed"
    engine.dispose()


def test_git_metadata_never_runs_repository_configured_filters(tmp_path):
    import os
    import shutil
    import subprocess

    from plenger.services.snapshot import _git_metadata

    git = shutil.which("git")
    if git is None:
        pytest.skip("git is unavailable")
    environment = {
        "PATH": "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_TERMINAL_PROMPT": "0",
        "LC_ALL": "C",
    }
    repository = tmp_path / "repo"
    repository.mkdir()
    command = [git, "-C", str(repository)]
    for args in (
        ("init", "--quiet"),
        ("config", "user.email", "test@plenger.invalid"),
        ("config", "user.name", "plenger Test"),
    ):
        subprocess.run([*command, *args], env=environment, check=True)
    (repository / ".gitattributes").write_text("*.py filter=evil filter=other.driver\n")
    (repository / "a.py").write_text("value = 1\n")
    subprocess.run([*command, "add", "-A"], env=environment, check=True)
    subprocess.run(
        [*command, "commit", "--quiet", "--no-gpg-sign", "-m", "fixture"],
        env=environment,
        check=True,
    )
    clean_marker = tmp_path / "clean-ran"
    process_marker = tmp_path / "process-ran"
    hook_marker = tmp_path / "hook-ran"
    hooks = repository / ".git" / "hooks"
    (hooks / "post-index-change").write_text(f"#!/bin/sh\ntouch {hook_marker}\n")
    (hooks / "post-index-change").chmod(0o755)
    for key, value in (
        ("filter.evil.clean", f"sh -c 'touch {clean_marker}; cat'"),
        ("filter.evil.required", "true"),
        ("filter.other.driver.process", f"sh -c 'touch {process_marker}; exit 1'"),
        ("core.fsmonitor", f"sh -c 'touch {clean_marker}'"),
    ):
        subprocess.run([*command, "config", key, value], env=environment, check=True)
    (repository / "a.py").write_text("value = 2\n")

    commit, dirty = _git_metadata(repository)

    assert commit is not None
    assert dirty is True
    assert not clean_marker.exists()
    assert not process_marker.exists()
    assert not hook_marker.exists()


def test_git_metadata_fails_closed_for_unrecognized_filter_driver_names(tmp_path, monkeypatch):
    from plenger.services import snapshot

    monkeypatch.setattr(
        snapshot,
        "_git_run",
        lambda root, args, limit: (0, b"filter.bad name=x.clean\nsh\0"),
    )

    assert snapshot._git_status_has_output(tmp_path) is None
