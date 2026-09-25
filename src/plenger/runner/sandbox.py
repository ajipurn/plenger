"""OS-level egress isolation for the trusted active-suite worker."""

from __future__ import annotations

import functools
import os
import platform
import shutil
import subprocess
import sys
import sysconfig
from collections.abc import Sequence
from pathlib import Path

MAX_SANDBOX_PROBE_SECONDS = 3
LINUX_BROKER_MOUNT = Path("/run/plenger-active-broker")


def _sbpl_path(path: Path) -> str:
    value = str(path.resolve())
    if any(character in value for character in ("\x00", "\n", "\r")):
        raise ValueError("active_worker_path_invalid")
    return value.replace("\\", "\\\\").replace('"', '\\"')


def _python_read_roots() -> set[Path]:
    roots = {
        Path("/System"),
        Path("/Library"),
        Path("/usr"),
        Path("/bin"),
        Path("/sbin"),
        Path("/dev"),
        Path("/etc"),
        Path("/private/etc"),
        Path(sys.prefix),
        Path(sys.base_prefix),
        Path(sysconfig.get_path("stdlib")),
        Path(sysconfig.get_path("platstdlib")),
        Path(sysconfig.get_path("purelib")),
        Path(sysconfig.get_path("platlib")),
        Path(__file__).resolve().parents[2],
    }
    return {path.resolve() for path in roots if path.exists() and path != Path("/")}


def _seatbelt_profile(broker_socket: Path) -> str:
    executable = Path(sys.executable).resolve()
    read_roots = _python_read_roots() | {executable.parent}
    metadata_roots = {path.parent for path in read_roots} | {broker_socket.parent.resolve()}
    socket_path = _sbpl_path(broker_socket)
    executable_path = _sbpl_path(executable)

    def path_rules(operation: str, paths: set[Path]) -> str:
        values = " ".join(f'(subpath "{_sbpl_path(path)}")' for path in sorted(paths))
        return f"(allow {operation} {values})"

    return " ".join(
        (
            "(version 1)",
            '(import "system.sb")',
            "(deny default)",
            "(allow process-fork)",
            "(allow sysctl-read)",
            path_rules("file-read* file-test-existence file-map-executable", read_roots),
            path_rules("file-read-metadata file-test-existence", metadata_roots),
            f'(allow process-exec (literal "{executable_path}"))',
            "(deny network*)",
            f'(allow network-outbound (to unix-socket (path-literal "{socket_path}")))',
        )
    )


def _linux_bwrap() -> str | None:
    return shutil.which("bwrap")


def _probe_command() -> list[str] | None:
    system = platform.system()
    if system == "Darwin":
        sandbox_exec = shutil.which("sandbox-exec")
        if sandbox_exec is None:
            return None
        profile = _seatbelt_profile(Path(tempfile_socket_probe_path()))
        return [sandbox_exec, "-p", profile, sys.executable, "-c", "pass"]
    if system == "Linux":
        bwrap = _linux_bwrap()
        if bwrap is None:
            return None
        return [
            bwrap,
            "--die-with-parent",
            "--unshare-net",
            "--ro-bind",
            "/",
            "/",
            "--dev",
            "/dev",
            "--proc",
            "/proc",
            "--",
            sys.executable,
            "-c",
            "pass",
        ]
    return None


def tempfile_socket_probe_path() -> str:
    """Return a harmless absolute path for compiling a Seatbelt profile."""

    return os.fspath(Path(os.getenv("TMPDIR", "/tmp")) / "plenger-active-probe.sock")


@functools.lru_cache(maxsize=1)
def active_worker_capability() -> dict[str, str]:
    """Probe the required no-network worker boundary; fail closed if unavailable."""

    if os.name != "posix":
        return {"status": "unavailable", "reason": "active_worker_sandbox_unavailable"}
    command = _probe_command()
    if command is None:
        return {"status": "unavailable", "reason": "active_worker_sandbox_unavailable"}
    environment = {
        "HOME": "/nonexistent",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONNOUSERSITE": "1",
        "PYTHONPATH": os.fspath(Path(__file__).resolve().parents[2]),
    }
    try:
        result = subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=environment,
            timeout=MAX_SANDBOX_PROBE_SECONDS,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return {"status": "unavailable", "reason": "active_worker_sandbox_unavailable"}
    if result.returncode != 0:
        return {"status": "unavailable", "reason": "active_worker_sandbox_unavailable"}
    isolation = (
        "darwin_seatbelt_network_denied"
        if platform.system() == "Darwin"
        else "linux_network_namespace_isolated"
    )
    return {"status": "ready", "reason": isolation}


def confined_worker_command(
    broker_socket: Path, python_arguments: Sequence[str] | None = None
) -> tuple[list[str], str]:
    """Build the trusted worker command and its broker path inside the sandbox."""

    socket_path = broker_socket.resolve()
    worker_arguments = list(python_arguments or ("-m", "plenger.runner.worker"))
    if platform.system() == "Darwin":
        sandbox_exec = shutil.which("sandbox-exec")
        if sandbox_exec is None:
            raise RuntimeError("active_worker_sandbox_unavailable")
        return (
            [
                sandbox_exec,
                "-p",
                _seatbelt_profile(socket_path),
                sys.executable,
                *[
                    os.fspath(socket_path) if argument == "{broker_socket}" else argument
                    for argument in worker_arguments
                ],
            ],
            os.fspath(socket_path),
        )
    if platform.system() == "Linux":
        bwrap = _linux_bwrap()
        if bwrap is None:
            raise RuntimeError("active_worker_sandbox_unavailable")
        parent = socket_path.parent
        in_sandbox = LINUX_BROKER_MOUNT / socket_path.name
        command = [
            bwrap,
            "--die-with-parent",
            "--unshare-net",
            "--ro-bind",
            "/",
            "/",
            "--dir",
            os.fspath(LINUX_BROKER_MOUNT.parent),
            "--dir",
            os.fspath(LINUX_BROKER_MOUNT),
            "--ro-bind",
            os.fspath(parent),
            os.fspath(LINUX_BROKER_MOUNT),
            "--tmpfs",
            "/tmp",
            "--dev",
            "/dev",
            "--proc",
            "/proc",
            "--setenv",
            "HOME",
            "/nonexistent",
            "--setenv",
            "PYTHONDONTWRITEBYTECODE",
            "1",
            "--",
            sys.executable,
            *[
                os.fspath(in_sandbox) if argument == "{broker_socket}" else argument
                for argument in worker_arguments
            ],
        ]
        return command, os.fspath(in_sandbox)
    raise RuntimeError("active_worker_sandbox_unavailable")


__all__ = ["active_worker_capability", "confined_worker_command"]
