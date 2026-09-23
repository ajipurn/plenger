"""Stable, project-local source identity without persisting raw source or unkeyed hashes."""

import hashlib
import hmac
import os
import re
import selectors
import shutil
import signal
import subprocess
import uuid
from pathlib import Path
from typing import Any

from plenger.policy import redact
from plenger.storage.runs import digest, now

GIT_TIMEOUT_SECONDS = 2
GIT_OUTPUT_LIMIT = 256


def _git_environment() -> dict[str, str]:
    return {
        "PATH": "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_OPTIONAL_LOCKS": "0",
        "GIT_TERMINAL_PROMPT": "0",
        "LC_ALL": "C",
    }


def _git_command(root: Path, args: tuple[str, ...]) -> str | None:
    executable = shutil.which("git")
    if executable is None:
        return None
    try:
        result = subprocess.run(
            [executable, "-C", str(root), "-c", "core.fsmonitor=false", *args],
            env=_git_environment(),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=GIT_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0 or len(result.stdout) > GIT_OUTPUT_LIMIT:
        return None
    return result.stdout.decode("utf-8", errors="replace").strip()


def _stop_git_process(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is None:
        if os.name == "posix":
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except (PermissionError, ProcessLookupError):
                pass
        try:
            process.kill()
        except ProcessLookupError:
            pass
    try:
        process.wait(timeout=1)
    except subprocess.TimeoutExpired:
        pass


def _git_status_has_output(root: Path) -> bool | None:
    executable = shutil.which("git")
    if executable is None:
        return None
    try:
        process = subprocess.Popen(
            [
                executable,
                "-C",
                str(root),
                "-c",
                "core.fsmonitor=false",
                "status",
                "--porcelain=v1",
                "--untracked-files=normal",
                "--no-renames",
                "--",
                ".",
            ],
            env=_git_environment(),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except OSError:
        return None

    assert process.stdout is not None
    selector = selectors.DefaultSelector()
    try:
        selector.register(process.stdout, selectors.EVENT_READ)
        if not selector.select(timeout=GIT_TIMEOUT_SECONDS):
            return None
        if process.stdout.read(1):
            return True
        try:
            return False if process.wait(timeout=1) == 0 else None
        except subprocess.TimeoutExpired:
            return None
    except (OSError, ValueError):
        return None
    finally:
        selector.close()
        _stop_git_process(process)


def _git_metadata(root: Path) -> tuple[str | None, bool | None]:
    try:
        if (root / ".git").is_symlink():
            return None, None
    except OSError:
        return None, None
    if _git_command(root, ("rev-parse", "--is-inside-work-tree")) != "true":
        return None, None
    commit = _git_command(root, ("rev-parse", "--verify", "HEAD^{commit}"))
    if commit is not None and re.fullmatch(r"(?:[0-9a-f]{40}|[0-9a-f]{64})", commit) is None:
        commit = None
    return commit, _git_status_has_output(root)


def manifest(
    files: dict[str, str],
    skipped: list[dict[str, str]],
    key: bytes,
    project_id: str,
    root: Path | None = None,
) -> dict[str, Any]:
    entries = [
        {
            "path": redact(path),
            "size": len(source.encode("utf-8")),
            "encoding": "utf-8",
            "content_hmac_sha256": hmac.new(
                key, source.encode("utf-8"), hashlib.sha256
            ).hexdigest(),
        }
        for path, source in sorted(files.items())
    ]
    commit, dirty = _git_metadata(root) if root is not None else (None, None)
    limitations = [
        "UTF-8 Python files only; unsupported/excluded input is listed",
        "Content identity is HMAC-SHA256 scoped to this project",
    ]
    if commit is None:
        limitations.insert(0, "Git commit unavailable; commit remains unknown")
    if dirty is None:
        limitations.insert(0, "Git working-tree state unavailable; dirty remains unknown")
    # A source UUID identifies this capture; digest identifies comparable content.
    return {
        "id": str(uuid.uuid4()),
        "project_id": project_id,
        "created_at": now(),
        "manifest_digest": digest(entries),
        "files": entries,
        "skipped": redact(skipped),
        "commit": commit,
        "dirty": dirty,
        "limitations": limitations,
    }
