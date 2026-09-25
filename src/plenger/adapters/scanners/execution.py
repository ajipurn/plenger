"""Confined, bounded execution of a planned scanner process."""

from __future__ import annotations

import os
import platform
import shutil
import signal
import subprocess
import tempfile
import threading
from pathlib import Path
from typing import Any

from plenger.adapters.scanners.containers import (
    cleanup_container,
    container_execution_argv,
    container_runtime_mode,
    docker_environment,
)
from plenger.adapters.scanners.models import (
    MAX_OUTPUT_BYTES,
    ScannerExecutionError,
    ScannerOutputError,
    ScannerPlan,
    ScannerResult,
)
from plenger.adapters.scanners.normalize import (
    map_container_output,
    normalize_osv,
    normalize_semgrep,
    normalize_trivy,
)

MAX_STDERR_BYTES = 256 * 1024


def _safe_environment(binary: Path, runtime_home: Path | None = None) -> dict[str, str]:
    home = runtime_home or Path("/nonexistent")
    environment = {
        "PATH": str(binary.parent) + ":/usr/local/bin:/usr/bin:/bin",
        "HOME": str(home),
        "XDG_CONFIG_HOME": str(home / "config"),
        "XDG_CACHE_HOME": str(home / "cache"),
        "XDG_DATA_HOME": str(home / "data"),
        "TRIVY_CACHE_DIR": str(home / "trivy-cache"),
        "TMPDIR": str(home),
        "TMP": str(home),
        "TEMP": str(home),
        "LC_ALL": "C.UTF-8",
        "SEMGREP_SEND_METRICS": "off",
    }
    if platform.system() == "Darwin":
        environment["SSL_CERT_FILE"] = "/etc/ssl/cert.pem"
    return environment


def scanner_isolation_mode() -> str:
    if platform.system() == "Darwin":
        return "seatbelt_default_deny" if shutil.which("sandbox-exec") else "unavailable"
    return container_runtime_mode()


def _sbpl_path(path: Path) -> str:
    value = str(path.resolve())
    if any(character in value for character in ("\x00", "\n", "\r")):
        raise ScannerExecutionError("scanner_isolation_path_invalid")
    return value.replace("\\", "\\\\").replace('"', '\\"')


def _seatbelt_profile(plan: ScannerPlan, runtime_home: Path) -> str:
    """Build a default-deny profile for a scanner and its ephemeral inputs."""

    executable = plan.executable.resolve()
    read_roots = {
        Path("/System"),
        Path("/Library"),
        Path("/usr"),
        Path("/bin"),
        Path("/sbin"),
        Path("/dev"),
        Path("/etc"),
        Path("/private/etc"),
        executable.parent,
        plan.target_root,
        runtime_home,
    }
    if plan.engine == "semgrep" and "--config" in plan.argv:
        config_index = plan.argv.index("--config") + 1
        if config_index < len(plan.argv):
            read_roots.add(Path(plan.argv[config_index]))
    exec_roots = {Path("/usr"), Path("/bin"), Path("/sbin"), executable.parent}
    for trusted_root in (Path("/opt/homebrew"), Path("/usr/local")):
        if executable.is_relative_to(trusted_root):
            read_roots.add(trusted_root)
            exec_roots.add(trusted_root)
    metadata_roots = {path.parent for path in (*read_roots, *exec_roots)}

    def rules(operation: str, paths: set[Path]) -> str:
        values = " ".join(f'(subpath "{_sbpl_path(path)}")' for path in sorted(paths))
        return f"(allow {operation} {values})"

    return " ".join(
        (
            "(version 1)",
            '(import "system.sb")',
            "(deny default)",
            "(allow network-outbound)" if plan.provisioning else "(deny network*)",
            "(allow mach-lookup)" if plan.provisioning else "",
            "(allow process-fork)",
            "(allow sysctl-read)",
            rules("file-read* file-test-existence file-map-executable", read_roots),
            rules("file-read-metadata file-test-existence", metadata_roots),
            rules("process-exec", exec_roots),
            rules("file-write*", {runtime_home}),
        )
    )


def _execution_argv(plan: ScannerPlan, runtime_home: Path | None = None) -> list[str]:
    if plan.container_image is not None:
        effective_runtime = runtime_home or plan.runtime_home or plan.target_root
        return container_execution_argv(plan, effective_runtime)
    if platform.system() == "Darwin":
        sandbox = shutil.which("sandbox-exec")
        if not sandbox:
            raise ScannerExecutionError("scanner_isolation_unavailable")
        return [
            sandbox,
            "-p",
            _seatbelt_profile(plan, runtime_home or plan.runtime_home or plan.target_root),
            *plan.argv,
        ]
    raise ScannerExecutionError("container_worker_required")


def run_scanner_process(plan: ScannerPlan) -> bytes:
    if plan.runtime_home is not None:
        return _run_bounded_process(plan, plan.runtime_home)
    with tempfile.TemporaryDirectory(prefix="plenger-scanner-") as runtime:
        return _run_bounded_process(plan, Path(runtime))


def _run_bounded_process(plan: ScannerPlan, runtime_home: Path) -> bytes:
    try:
        process = subprocess.Popen(
            _execution_argv(plan, runtime_home),
            cwd=plan.target_root,
            env=(
                docker_environment()
                if plan.container_image is not None
                else _safe_environment(plan.executable, runtime_home)
            ),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
    except OSError:
        raise ScannerExecutionError("scanner_start_failed") from None
    stdout = bytearray()
    stderr = bytearray()
    overflow = threading.Event()

    def kill_process_group() -> None:
        if process.poll() is not None:
            return
        if os.name == "posix":
            try:
                os.killpg(process.pid, signal.SIGKILL)
                return
            except (ProcessLookupError, PermissionError):
                pass
        process.kill()

    def consume(pipe: Any, buffer: bytearray, limit: int) -> None:
        try:
            while chunk := pipe.read(65536):
                if len(buffer) + len(chunk) > limit:
                    overflow.set()
                    kill_process_group()
                    return
                buffer.extend(chunk)
        except OSError:
            return

    assert process.stdout is not None and process.stderr is not None
    threads = [
        threading.Thread(target=consume, args=(process.stdout, stdout, MAX_OUTPUT_BYTES)),
        threading.Thread(target=consume, args=(process.stderr, stderr, MAX_STDERR_BYTES)),
    ]
    for thread in threads:
        thread.start()
    try:
        process.wait(timeout=plan.timeout_seconds)
        for thread in threads:
            thread.join(timeout=2)
        if overflow.is_set():
            raise ScannerExecutionError("scanner_output_too_large")
        if any(thread.is_alive() for thread in threads):
            raise ScannerExecutionError("scanner_output_reader_stuck")
        if process.returncode not in {0, 1}:
            raise ScannerExecutionError("scanner_failed")
        if not stdout:
            raise ScannerExecutionError("scanner_empty_output")
        return bytes(stdout)
    except subprocess.TimeoutExpired:
        raise ScannerExecutionError("scanner_timeout") from None
    finally:
        if process.poll() is None:
            kill_process_group()
        process.wait()
        if plan.container_image is not None:
            cleanup_container(plan)
        for thread in threads:
            thread.join(timeout=2)


def execute_scanner(plan: ScannerPlan) -> ScannerResult:
    """Execute one pinned, offline scanner and normalize only its stdout."""

    normalizers = {
        "semgrep": normalize_semgrep,
        "osv": normalize_osv,
        "trivy": normalize_trivy,
    }
    try:
        raw = run_scanner_process(plan)
        if plan.container_image is not None:
            raw = map_container_output(raw, plan.engine)
        result = normalizers[plan.engine](raw, base_dir=plan.target_root)
    except (ScannerExecutionError, ScannerOutputError, ValueError) as exc:
        return ScannerResult(
            engine=plan.engine,
            status="error",
            reason=str(exc)[:128],
            findings=[],
            manifest=plan.manifest,
        )
    return result.model_copy(update={"manifest": plan.manifest})


def probe_optional_engines() -> dict[str, dict[str, str]]:
    result: dict[str, dict[str, str]] = {}
    isolation = scanner_isolation_mode()
    for name, binary in (("semgrep", "semgrep"), ("osv", "osv-scanner"), ("trivy", "trivy")):
        path = shutil.which(binary)
        result[name] = {
            "status": "unavailable",
            "reason": "managed_config_not_provisioned" if path else "binary_missing",
            "isolation": isolation,
        }
    return result
