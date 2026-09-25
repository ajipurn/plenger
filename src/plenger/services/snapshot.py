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

from plenger.policy.redaction import redact
from plenger.storage.runs import digest, now

GIT_TIMEOUT_SECONDS = 2
GIT_OUTPUT_LIMIT = 256
GIT_CONFIG_OUTPUT_LIMIT = 64 * 1024
MAX_GIT_FILTER_DRIVERS = 64
_SAFE_FILTER_DRIVER = re.compile(r"[A-Za-z0-9_.+/-]{1,128}")
# The target repository's own .git/config is untrusted. These overrides disable the
# configuration hooks that can make read-only status commands spawn programs.
_GIT_BASE_OVERRIDES = (
    "core.fsmonitor=false",
    "core.hooksPath=" + os.devnull,
    "core.attributesFile=" + os.devnull,
    "core.untrackedCache=false",
    "status.submoduleSummary=false",
)


def _git_environment() -> dict[str, str]:
    return {
        "PATH": "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_ATTR_NOSYSTEM": "1",
        "GIT_OPTIONAL_LOCKS": "0",
        "GIT_TERMINAL_PROMPT": "0",
        "LC_ALL": "C",
    }


def _git_base_arguments(executable: str, root: Path) -> list[str]:
    arguments = [executable, "-C", str(root)]
    for override in _GIT_BASE_OVERRIDES:
        arguments.extend(("-c", override))
    return arguments


def _git_run(root: Path, args: tuple[str, ...], limit: int) -> tuple[int, bytes] | None:
    executable = shutil.which("git")
    if executable is None:
        return None
    try:
        result = subprocess.run(
            [*_git_base_arguments(executable, root), *args],
            env=_git_environment(),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=GIT_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if len(result.stdout) > limit:
        return None
    return result.returncode, result.stdout


def _git_command(root: Path, args: tuple[str, ...]) -> str | None:
    result = _git_run(root, args, GIT_OUTPUT_LIMIT)
    if result is None or result[0] != 0:
        return None
    return result[1].decode("utf-8", errors="replace").strip()


def _filter_driver_overrides(root: Path) -> list[str] | None:
    """Neutralize every filter driver declared by repository-local configuration.

    ``git status`` runs ``filter.<driver>.clean``/``process`` commands for paths whose
    attributes name that driver. Listing configuration never executes it, so each
    declared driver is overridden with an empty command. Unexpected output fails
    closed and leaves the dirty state unknown.
    """

    result = _git_run(
        root,
        ("config", "--null", "--includes", "--get-regexp", r"^filter\."),
        GIT_CONFIG_OUTPUT_LIMIT,
    )
    if result is None:
        return None
    code, output = result
    if code == 1 and not output:
        return []
    if code != 0:
        return None
    drivers: set[str] = set()
    for entry in output.split(b"\0"):
        if not entry:
            continue
        key = entry.split(b"\n", 1)[0].decode("utf-8", errors="replace")
        if not key.startswith("filter.") or key.count(".") < 2:
            return None
        driver = key[len("filter.") :].rsplit(".", 1)[0]
        if _SAFE_FILTER_DRIVER.fullmatch(driver) is None:
            return None
        drivers.add(driver)
        if len(drivers) > MAX_GIT_FILTER_DRIVERS:
            return None
    overrides: list[str] = []
    for driver in sorted(drivers):
        for variable in ("clean", "smudge", "process"):
            overrides.extend(("-c", f"filter.{driver}.{variable}="))
        overrides.extend(("-c", f"filter.{driver}.required=false"))
    return overrides


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
    filter_overrides = _filter_driver_overrides(root)
    if filter_overrides is None:
        return None
    try:
        process = subprocess.Popen(
            [
                *_git_base_arguments(executable, root),
                *filter_overrides,
                "status",
                "--porcelain=v1",
                "--untracked-files=normal",
                "--ignore-submodules=all",
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
