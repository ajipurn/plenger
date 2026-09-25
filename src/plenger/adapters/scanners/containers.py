"""Digest-pinned scanner images and the local Docker runtime that executes them."""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

from plenger.adapters.scanners.models import EngineName, ScannerExecutionError, ScannerPlan

CONTAINER_PULL_TIMEOUT_SECONDS = 300

SCANNER_CONTAINER_IMAGES: dict[EngineName, str] = {
    "semgrep": (
        "semgrep/semgrep@sha256:e5ea1a270ca5557a114ae7a30a8f860cc16a924f8df85cd975688f17c7c97731"
    ),
    "osv": (
        "ghcr.io/google/osv-scanner@sha256:"
        "afd838850ac1a0fcc15ff4a041dc9ba11123c3f0d2666217a5f0fcf9222b55fa"
    ),
    "trivy": (
        "aquasec/trivy@sha256:62b1e65e8869bc4b4c6aa4fa2b21595256c7c2f6018a9d9ad61caf87187c1969"
    ),
}
SCANNER_CONTAINER_COMMANDS: dict[EngineName, tuple[str, ...]] = {
    "semgrep": ("semgrep",),
    "osv": (),
    "trivy": (),
}
SCANNER_CONTAINER_VERSIONS: dict[EngineName, str] = {
    "semgrep": "1.176.0",
    "osv": "2.6.0",
    "trivy": "0.74.0",
}
SCANNER_CONTAINER_MEMORY: dict[EngineName, str] = {
    "semgrep": "512m",
    "osv": "1g",
    "trivy": "512m",
}


def docker_environment() -> dict[str, str]:
    return {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": str(Path.home())}


def _docker_command() -> list[str]:
    docker = shutil.which("docker")
    if not docker:
        raise ScannerExecutionError("docker_missing")
    try:
        context = subprocess.run(
            [docker, "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
            env=docker_environment(),
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise ScannerExecutionError("docker_unavailable") from None
    endpoint = context.stdout.decode("utf-8", errors="replace").strip()
    if (
        context.returncode != 0
        or len(endpoint) > 4096
        or not endpoint.startswith("unix:///")
        or "\n" in endpoint
    ):
        raise ScannerExecutionError("remote_docker_forbidden")
    return [docker, "--host", endpoint]


def container_runtime_mode() -> str:
    try:
        _docker_command()
    except ScannerExecutionError:
        return "unavailable"
    return "docker_pinned"


def container_image_present(image: str) -> bool:
    try:
        command = _docker_command()
        result = subprocess.run(
            [*command, "image", "inspect", image],
            env=docker_environment(),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=5,
            check=False,
        )
    except (OSError, ScannerExecutionError, subprocess.TimeoutExpired):
        return False
    return result.returncode == 0


def pull_container_image(image: str) -> tuple[bool, str]:
    """Pull one configured digest explicitly, then verify it is locally usable."""

    if image not in SCANNER_CONTAINER_IMAGES.values():
        return False, "container_image_not_allowed"
    try:
        command = _docker_command()
        result = subprocess.run(
            [*command, "pull", "--quiet", image],
            env=docker_environment(),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=CONTAINER_PULL_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, ScannerExecutionError, subprocess.TimeoutExpired):
        return False, "container_image_pull_failed"
    if result.returncode != 0:
        return False, "container_image_pull_failed"
    if not container_image_present(image):
        return False, "container_image_missing"
    return True, "container_image_pulled"


def _container_user() -> str:
    try:
        uid = os.getuid()
        gid = os.getgid()
    except AttributeError:
        raise ScannerExecutionError("container_non_root_user_unavailable") from None
    if uid <= 0 or gid < 0:
        raise ScannerExecutionError("container_non_root_user_unavailable")
    return f"{uid}:{gid}"


def container_user_available() -> bool:
    try:
        _container_user()
    except (AttributeError, ScannerExecutionError):
        return False
    return True


def _container_mount_source(path: Path) -> str:
    value = str(path.resolve())
    if any(character in value for character in ("\x00", "\n", "\r", ",")):
        raise ScannerExecutionError("scanner_container_path_invalid")
    return value


def container_version_probe(engine: EngineName, image: str) -> str | None:
    if image != SCANNER_CONTAINER_IMAGES[engine]:
        return None
    if not container_image_present(image):
        return None
    return SCANNER_CONTAINER_VERSIONS[engine]


def container_execution_argv(plan: ScannerPlan, runtime_home: Path) -> list[str]:
    if plan.container_image is None or plan.container_name is None:
        raise ScannerExecutionError("scanner_container_plan_invalid")
    user = _container_user()
    command = [
        *_docker_command(),
        "run",
        "--rm",
        "--pull=never",
        "-i",
        "--name",
        plan.container_name,
        "--label=io.plenger.managed=scanner-v1",
        "--network=bridge" if plan.provisioning else "--network=none",
        "--read-only",
        "--user",
        user,
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--pids-limit",
        "32",
        "--memory",
        SCANNER_CONTAINER_MEMORY[plan.engine],
        "--cpus",
        "1",
        "--log-driver=none",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,nodev,size=64m",
        "--workdir",
        "/src",
        "--mount",
        f"type=bind,source={_container_mount_source(plan.target_root)},target=/src,readonly",
        "--env",
        "HOME=/runtime" if plan.runtime_home is not None else "HOME=/tmp",
        "--env",
        (
            "XDG_CONFIG_HOME=/runtime/config"
            if plan.runtime_home is not None
            else "XDG_CONFIG_HOME=/tmp/config"
        ),
        "--env",
        (
            "XDG_CACHE_HOME=/runtime/cache"
            if plan.runtime_home is not None
            else "XDG_CACHE_HOME=/tmp/cache"
        ),
        "--env",
        (
            "XDG_DATA_HOME=/runtime/data"
            if plan.runtime_home is not None
            else "XDG_DATA_HOME=/tmp/data"
        ),
        "--env",
        "TMPDIR=/tmp",
        "--env",
        "LC_ALL=C.UTF-8",
        "--env",
        "SEMGREP_SEND_METRICS=off",
    ]
    if plan.runtime_home is not None:
        runtime_mount = (
            f"type=bind,source={_container_mount_source(plan.runtime_home)},target=/runtime"
        )
        if not plan.provisioning:
            runtime_mount += ",readonly"
        command.extend(("--mount", runtime_mount))
    if plan.managed_rule_path is not None:
        command.extend(
            (
                "--mount",
                f"type=bind,source={_container_mount_source(plan.managed_rule_path)},"
                "target=/rules/semgrep.yml,readonly",
            )
        )
    command.extend((plan.container_image, *plan.argv))
    return command


def cleanup_container(plan: ScannerPlan) -> None:
    if plan.container_name is None:
        return
    try:
        subprocess.run(
            [*_docker_command(), "container", "rm", "--force", plan.container_name],
            env=docker_environment(),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=5,
            check=False,
        )
    except (OSError, ScannerExecutionError, subprocess.TimeoutExpired):
        pass
