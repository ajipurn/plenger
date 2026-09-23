"""Run the immutable scanner-image release smoke without network access."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

from plenger.adapters.scanners import SCANNER_CONTAINER_IMAGES

SUPPORTED_PLATFORMS = ("linux/amd64", "linux/arm64")


class ScannerImageCheckError(RuntimeError):
    """Raised when the local immutable-image smoke cannot be completed."""


def _docker_environment() -> dict[str, str]:
    return {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/tmp"}


def _docker_command() -> list[str]:
    docker = shutil.which("docker")
    if docker is None:
        raise ScannerImageCheckError("docker_missing")
    try:
        context = subprocess.run(
            [docker, "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
            env=_docker_environment(),
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise ScannerImageCheckError("docker_unavailable") from None
    endpoint = context.stdout.decode("utf-8", errors="replace").strip()
    if (
        context.returncode != 0
        or not endpoint.startswith("unix:///")
        or len(endpoint) > 4096
        or "\n" in endpoint
    ):
        raise ScannerImageCheckError("remote_docker_forbidden")
    return [docker, "--host", endpoint]


def _safe_mount(path: Path) -> str:
    value = str(path.resolve())
    if any(character in value for character in ("\x00", "\n", "\r", ",")):
        raise ScannerImageCheckError("scanner_path_invalid")
    return value


def _run(command: list[str], output: Path) -> None:
    try:
        with output.open("wb") as stream:
            result = subprocess.run(
                command,
                env=_docker_environment(),
                stdin=subprocess.DEVNULL,
                stdout=stream,
                stderr=subprocess.PIPE,
                timeout=180,
                check=False,
            )
    except (OSError, subprocess.TimeoutExpired):
        raise ScannerImageCheckError("scanner_execution_failed") from None
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", errors="replace")[-512:].strip()
        suffix = f": {detail}" if detail else ""
        raise ScannerImageCheckError(f"scanner_execution_failed{suffix}")


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text())
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        raise ScannerImageCheckError("scanner_json_invalid") from None
    if not isinstance(value, dict):
        raise ScannerImageCheckError("scanner_json_invalid")
    return value


def _semgrep_findings(payload: dict[str, Any]) -> int:
    results = payload.get("results")
    if not isinstance(results, list):
        raise ScannerImageCheckError("semgrep_results_invalid")
    return len(results)


def _trivy_secret_findings(payload: dict[str, Any]) -> int:
    results = payload.get("Results")
    if results is None:
        return 0
    if not isinstance(results, list):
        raise ScannerImageCheckError("trivy_results_invalid")
    total = 0
    for result in results:
        if not isinstance(result, dict):
            raise ScannerImageCheckError("trivy_result_invalid")
        secrets = result.get("Secrets") or []
        if not isinstance(secrets, list):
            raise ScannerImageCheckError("trivy_secrets_invalid")
        total += len(secrets)
    return total


def _common_run_args(
    docker: list[str], source: Path, uid_gid: str, platform: str | None
) -> list[str]:
    command = [*docker, "run", "--rm", "--pull=never"]
    if platform is not None:
        command.extend(("--platform", platform))
    command.extend(
        [
            "-i",
            "--network=none",
            "--read-only",
            "--user",
            uid_gid,
            "--cap-drop=ALL",
            "--security-opt=no-new-privileges",
            "--pids-limit",
            "32",
            "--memory",
            "512m",
            "--cpus",
            "1",
            "--log-driver=none",
            "--tmpfs",
            "/tmp:rw,noexec,nosuid,nodev,size=64m",
            "--workdir",
            "/src",
            "--mount",
            f"type=bind,source={_safe_mount(source)},target=/src,readonly",
            "--env",
            "HOME=/tmp",
            "--env",
            "XDG_CONFIG_HOME=/tmp/config",
            "--env",
            "XDG_CACHE_HOME=/tmp/cache",
            "--env",
            "XDG_DATA_HOME=/tmp/data",
            "--env",
            "TMPDIR=/tmp",
            "--env",
            "LC_ALL=C.UTF-8",
            "--env",
            "SEMGREP_SEND_METRICS=off",
        ]
    )
    return command


def _check_images(docker: list[str], platform: str | None) -> None:
    for name, image in SCANNER_CONTAINER_IMAGES.items():
        inspect = [*docker, "image", "inspect"]
        if platform is not None:
            inspect.extend(("--platform", platform))
        result = subprocess.run(
            [*inspect, image],
            env=_docker_environment(),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=5,
            check=False,
        )
        if result.returncode != 0:
            raise ScannerImageCheckError(f"{name}_image_missing")


def run_check(project_root: Path, platform: str | None = None) -> tuple[int, int]:
    if platform is not None and platform not in SUPPORTED_PLATFORMS:
        raise ScannerImageCheckError("scanner_platform_invalid")
    source = (project_root / "src").resolve()
    rules = (project_root / "src" / "plenger" / "adapters" / "rules" / "semgrep.yml").resolve()
    if not source.is_dir() or not rules.is_file():
        raise ScannerImageCheckError("production_source_missing")
    try:
        uid = os.getuid()
        gid = os.getgid()
    except AttributeError:
        raise ScannerImageCheckError("non_root_user_unavailable") from None
    if uid <= 0 or gid < 0:
        raise ScannerImageCheckError("non_root_user_unavailable")
    docker = _docker_command()
    _check_images(docker, platform)
    with tempfile.TemporaryDirectory(prefix="plenger-scanner-smoke-") as temporary:
        output_dir = Path(temporary)
        semgrep_output = output_dir / "semgrep.json"
        trivy_output = output_dir / "trivy.json"
        semgrep = [
            *_common_run_args(docker, source, f"{uid}:{gid}", platform),
            "--mount",
            f"type=bind,source={_safe_mount(rules)},target=/rules/semgrep.yml,readonly",
            SCANNER_CONTAINER_IMAGES["semgrep"],
            "semgrep",
            "--json",
            "--metrics=off",
            "--disable-version-check",
            "--config",
            "/rules/semgrep.yml",
            "/src",
        ]
        trivy = [
            *_common_run_args(docker, source, f"{uid}:{gid}", platform),
            SCANNER_CONTAINER_IMAGES["trivy"],
            "fs",
            "--format",
            "json",
            "--scanners",
            "secret",
            "--skip-db-update",
            "--skip-check-update",
            "--skip-version-check",
            "--no-progress",
            "/src",
        ]
        _run(semgrep, semgrep_output)
        _run(trivy, trivy_output)
        semgrep_findings = _semgrep_findings(_read_json(semgrep_output))
        trivy_findings = _trivy_secret_findings(_read_json(trivy_output))
    if semgrep_findings or trivy_findings:
        raise ScannerImageCheckError(
            f"production_source_findings: semgrep={semgrep_findings},trivy_secrets={trivy_findings}"
        )
    return semgrep_findings, trivy_findings


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--project-root",
        type=Path,
        default=Path(__file__).resolve().parents[1],
        help="plenger project root containing src/ (default: repository root)",
    )
    parser.add_argument(
        "--platform",
        choices=SUPPORTED_PLATFORMS,
        help="Explicit Docker platform for a cross-architecture smoke (default: host platform)",
    )
    arguments = parser.parse_args()
    try:
        semgrep_findings, trivy_findings = run_check(arguments.project_root, arguments.platform)
    except ScannerImageCheckError as error:
        print(f"scanner image smoke failed: {error}", file=sys.stderr)
        return 1
    print(
        "scanner image smoke passed: "
        f"images={len(SCANNER_CONTAINER_IMAGES)} "
        f"platform={arguments.platform or 'host'} "
        f"semgrep_findings={semgrep_findings} "
        f"trivy_secret_findings={trivy_findings}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
