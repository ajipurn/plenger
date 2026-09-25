"""Pinned, offline-only deterministic worker transport."""

import json
import shutil
import subprocess
import threading
import uuid
from pathlib import Path
from typing import Any

from plenger.domain.parser import ParserResult

IMAGE = "python@sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea"
OUTPUT_LIMIT = 16 * 1024 * 1024
# The worker container has a fixed memory/time budget, so large captures are parsed
# in bounded batches instead of one payload sized by the whole repository.
BATCH_INPUT_BYTES = 24 * 1024 * 1024
BATCH_MAX_FILES = 2000
BATCH_TIMEOUT_SECONDS = 60


class SandboxError(RuntimeError):
    pass


def docker_env() -> dict[str, str]:
    return {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": str(Path.home())}


def docker_command() -> list[str]:
    docker = shutil.which("docker")
    if not docker:
        raise SandboxError("docker_missing")
    try:
        context = subprocess.run(
            [docker, "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
            env=docker_env(),
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise SandboxError("docker_unavailable") from None
    endpoint = context.stdout.decode("utf-8", errors="replace").strip()
    if (
        context.returncode != 0
        or len(endpoint) > 4096
        or not endpoint.startswith("unix:///")
        or "\n" in endpoint
    ):
        raise SandboxError("remote_docker_forbidden")
    # Explicit socket prevents a saved remote Docker context receiving repository source.
    return [docker, "--host", endpoint]


def probe() -> dict[str, str]:
    try:
        result = subprocess.run(
            [*docker_command(), "image", "inspect", IMAGE],
            env=docker_env(),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=5,
        )
    except SandboxError as exc:
        return {"status": "unavailable", "reason": str(exc)}
    except (OSError, subprocess.TimeoutExpired):
        return {"status": "unavailable", "reason": "docker_unavailable"}
    return {
        "status": "ready" if result.returncode == 0 else "unavailable",
        "reason": "pinned_image_present" if result.returncode == 0 else "pinned_image_missing",
        "image_digest": IMAGE,
    }


def cleanup_run(run_id: str) -> bool:
    """Remove only exact-name, managed-label containers; never arbitrary scanner paths."""
    try:
        token = uuid.UUID(run_id).hex
        command = docker_command()
        for prefix, label in (
            ("plenger-", "io.plenger.managed=static-v1"),
            ("wonderkit-", "io.wonderkit.managed=static-v1"),
        ):
            result = subprocess.run(
                [
                    *command,
                    "container",
                    "ls",
                    "--all",
                    "--no-trunc",
                    "--filter",
                    "name=^/" + prefix + token + "$",
                    "--filter",
                    "label=" + label,
                    "--format",
                    "{{.ID}}",
                ],
                env=docker_env(),
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                timeout=5,
            )
            if result.returncode != 0:
                return False
            container = result.stdout.decode().strip()
            if not container:
                continue
            if len(container) != 64 or any(c not in "0123456789abcdef" for c in container):
                return False
            removal = subprocess.run(
                [*command, "container", "rm", "--force", container],
                env=docker_env(),
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=5,
            )
            if removal.returncode != 0:
                return False
        return True
    except (SandboxError, OSError, ValueError, subprocess.TimeoutExpired):
        return False


def sandbox_argv(name: str, worker: Path) -> list[str]:
    return [
        *docker_command(),
        "run",
        "--rm",
        "--pull=never",
        "-i",
        "--name",
        name,
        "--label=io.plenger.managed=static-v1",
        "--network=none",
        "--read-only",
        "--user=65534:65534",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--pids-limit=32",
        "--memory=512m",
        "--cpus=1",
        "--log-driver=none",
        "--mount",
        f"type=bind,source={worker},target=/worker.py,readonly",
        IMAGE,
        "python",
        "-I",
        "-B",
        "/worker.py",
    ]


def parser_batches(files: dict[str, str]) -> list[dict[str, str]]:
    """Split captured sources into deterministic batches bounded by size and count."""

    batches: list[dict[str, str]] = []
    current: dict[str, str] = {}
    current_bytes = 0
    for path, source in sorted(files.items()):
        size = len(path.encode()) + len(source.encode())
        if current and (
            current_bytes + size > BATCH_INPUT_BYTES or len(current) >= BATCH_MAX_FILES
        ):
            batches.append(current)
            current, current_bytes = {}, 0
        current[path] = source
        current_bytes += size
    if current or not batches:
        batches.append(current)
    return batches


def _execute_batch(files: dict[str, str], project_id: str, name: str) -> ParserResult:
    worker = Path(__file__).resolve().parents[1] / "graph" / "worker.py"
    payload = json.dumps({"files": files, "project_id": project_id}).encode()
    process = subprocess.Popen(
        sandbox_argv(name, worker),
        env=docker_env(),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    buffers: list[bytearray] = [bytearray(), bytearray()]
    overflow = threading.Event()

    def consume(index: int) -> None:
        pipe = process.stdout if index == 0 else process.stderr
        assert pipe is not None
        with pipe:
            while chunk := pipe.read(65536):
                if len(buffers[index]) + len(chunk) > OUTPUT_LIMIT:
                    overflow.set()
                    process.kill()
                    return
                buffers[index].extend(chunk)

    def send() -> None:
        assert process.stdin is not None
        try:
            with process.stdin:
                process.stdin.write(payload)
        except (BrokenPipeError, OSError):
            pass

    threads = [threading.Thread(target=consume, args=(i,), daemon=True) for i in range(2)]
    threads.append(threading.Thread(target=send, daemon=True))
    for thread in threads:
        thread.start()
    try:
        code = process.wait(timeout=BATCH_TIMEOUT_SECONDS)
        for thread in threads:
            thread.join(timeout=2)
        if overflow.is_set() or code != 0 or any(t.is_alive() for t in threads):
            raise SandboxError("worker_failed_or_output_limit")
        validated = ParserResult.model_validate(json.loads(buffers[0]))
        refs = [node.source_ref for node in validated.nodes]
        refs += [edge.source_ref for edge in validated.edges]
        refs += [finding.source_ref for finding in validated.findings]
        if any(ref.path not in files for ref in refs):
            raise SandboxError("invalid_source_reference")
        return validated
    except subprocess.TimeoutExpired:
        raise SandboxError("worker_timeout") from None
    except (ValueError, UnicodeDecodeError):
        raise SandboxError("invalid_worker_result") from None
    finally:
        if process.poll() is None:
            process.kill()
        process.wait()
        try:
            subprocess.run(
                [*docker_command(), "rm", "-f", name],
                env=docker_env(),
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=5,
            )
        except (SandboxError, OSError, subprocess.TimeoutExpired):
            pass
        for thread in threads:
            thread.join(timeout=2)


def execute(files: dict[str, str], project_id: str, run_id: str | None = None) -> dict[str, Any]:
    if probe()["status"] != "ready":
        raise SandboxError("sandbox_unavailable")
    # Batches run sequentially under the run's managed container name, so orphan
    # cleanup by run ID still finds any container left behind by a crash.
    name = "plenger-" + (uuid.UUID(run_id).hex if run_id else uuid.uuid4().hex)
    merged: dict[str, Any] = {
        "nodes": [],
        "edges": [],
        "findings": [],
        "errors": [],
        "limitations": [],
    }
    for batch in parser_batches(files):
        result = _execute_batch(batch, project_id, name).model_dump()
        for key in ("nodes", "edges", "findings", "errors"):
            merged[key].extend(result[key])
        if not merged["limitations"]:
            merged["limitations"] = result["limitations"]
    return merged
