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


def _loaded_image_roots() -> set[Path]:
    """Directories of dynamic libraries this interpreter already mapped (macOS only).

    Interpreters built by pyenv, Homebrew or conda link libraries such as libintl or
    OpenSSL from outside the Python prefix. The worker runs the same interpreter and
    imports the same modules, so these read-only roots are exactly what it needs.
    """

    if platform.system() != "Darwin":
        return set()
    try:
        import ctypes

        dyld = ctypes.CDLL(None)
        dyld._dyld_image_count.restype = ctypes.c_uint32
        dyld._dyld_get_image_name.restype = ctypes.c_char_p
        dyld._dyld_get_image_name.argtypes = [ctypes.c_uint32]
        count = int(dyld._dyld_image_count())
        names = [dyld._dyld_get_image_name(index) for index in range(count)]
    except (AttributeError, OSError, ValueError):
        return set()
    roots: set[Path] = set()
    for name in names:
        if not name:
            continue
        path = Path(os.fsdecode(name))
        if not path.is_absolute() or path.parts[:2] in {("/", "System"), ("/", "usr")}:
            continue
        roots.add(path.parent)
    return roots


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
        # Read-only package-manager prefixes that interpreters commonly link against.
        Path("/opt/homebrew"),
        Path("/usr/local"),
        Path("/opt/local"),
        *_loaded_image_roots(),
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


_LINUX_SYSTEM_READ_ROOTS = ("/usr", "/lib", "/lib64", "/lib32", "/bin", "/sbin", "/etc")


def _linux_bwrap_arguments(bwrap: str, broker_directory: Path | None) -> list[str]:
    """Build a minimal read-only filesystem instead of binding the host root.

    Binding ``/`` read-only would still let the worker connect() to every host
    Unix socket (for example ``/var/run/docker.sock``), because a read-only mount
    does not prevent socket connections. Only system libraries, the interpreter,
    plenger's source and the job's broker directory are visible here.
    """

    arguments = [
        bwrap,
        "--die-with-parent",
        "--new-session",
        "--unshare-all",
        "--cap-drop",
        "ALL",
        "--clearenv",
    ]
    system_roots = {Path(root) for root in _LINUX_SYSTEM_READ_ROOTS}
    for root in _LINUX_SYSTEM_READ_ROOTS:
        arguments.extend(("--ro-bind-try", root, root))
    for path in sorted(_python_read_roots() | {Path(sys.executable).parent}):
        value = os.fspath(path)
        if path in system_roots or value.startswith(("/dev", "/proc")):
            continue
        arguments.extend(("--ro-bind-try", value, value))
    arguments.extend(("--tmpfs", "/tmp", "--dev", "/dev", "--proc", "/proc"))
    if broker_directory is not None:
        arguments.extend(
            (
                "--dir",
                os.fspath(LINUX_BROKER_MOUNT),
                "--ro-bind",
                os.fspath(broker_directory),
                os.fspath(LINUX_BROKER_MOUNT),
            )
        )
    for name, value in (
        ("HOME", "/nonexistent"),
        ("PATH", "/usr/bin:/bin"),
        ("PYTHONDONTWRITEBYTECODE", "1"),
        ("PYTHONNOUSERSITE", "1"),
        ("PYTHONPATH", os.fspath(Path(__file__).resolve().parents[2])),
    ):
        arguments.extend(("--setenv", name, value))
    arguments.append("--")
    return arguments


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
        # Probe the same minimal layout the worker uses, so an interpreter that cannot
        # start without extra host paths fails closed here.
        return [*_linux_bwrap_arguments(bwrap, None), sys.executable, "-c", "import json, socket"]
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
        in_sandbox = LINUX_BROKER_MOUNT / socket_path.name
        command = [
            *_linux_bwrap_arguments(bwrap, socket_path.parent),
            sys.executable,
            *[
                os.fspath(in_sandbox) if argument == "{broker_socket}" else argument
                for argument in worker_arguments
            ],
        ]
        return command, os.fspath(in_sandbox)
    raise RuntimeError("active_worker_sandbox_unavailable")


__all__ = ["active_worker_capability", "confined_worker_command"]
