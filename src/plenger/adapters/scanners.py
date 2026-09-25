"""Strict offline contracts for optional scanner binaries and images.

The adapter never downloads databases or loads repository configuration. macOS
host binaries require the default-deny Seatbelt path; other platforms execute
only digest-pinned container images. A managed version and binary/image pin are
required before an optional engine becomes available.
"""

from __future__ import annotations

import hashlib
import json
import os
import platform
import re
import shutil
import signal
import subprocess
import tempfile
import threading
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, cast

from pydantic import Field, field_validator, model_validator

from plenger.domain.base import StrictModel
from plenger.policy.redaction import redact

MAX_OUTPUT_BYTES = 64 * 1024 * 1024
MAX_STDERR_BYTES = 256 * 1024
SCANNER_TIMEOUT_SECONDS = 120
CONTAINER_PULL_TIMEOUT_SECONDS = 300
VERSION_PROBE_TIMEOUT_SECONDS = 10
VERSION_PROBE_ATTEMPTS = 2
Severity = Literal["info", "low", "medium", "high", "critical", "unknown"]
EngineName = Literal["semgrep", "osv", "trivy"]
ScannerPattern = Literal[
    "python_ast_rules",
    "lockfile_advisories",
    "unresolved_dependency_advisories",
    "ranged_dependency_advisories",
    "filesystem_secrets",
]

_ENGINE_SUPPORTED_PATTERNS: dict[EngineName, frozenset[ScannerPattern]] = {
    "semgrep": frozenset({"python_ast_rules"}),
    "osv": frozenset(
        {
            "lockfile_advisories",
            "unresolved_dependency_advisories",
            "ranged_dependency_advisories",
        }
    ),
    "trivy": frozenset({"filesystem_secrets"}),
}

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


class EngineManifest(StrictModel):
    name: Literal["semgrep", "osv", "trivy"]
    adapter_version: str = "plenger-adapter-v1"
    engine_version: str | None = None
    image_digest: str | None = None
    binary_hash: str | None = None
    license_ref: str = Field(min_length=1, max_length=256)
    output_schema: str = Field(min_length=1, max_length=128)
    supported_modes: list[Literal["offline_static", "offline_db", "local_fixture"]]
    supported_patterns: list[ScannerPattern] = Field(min_length=1, max_length=32)
    required_network: Literal["none", "provisioning_only"] = "none"
    max_output_bytes: int = Field(default=MAX_OUTPUT_BYTES, ge=1, le=MAX_OUTPUT_BYTES)
    status: Literal["unavailable", "unsupported_version", "blocked_by_policy", "ready"]

    @model_validator(mode="after")
    def valid_supported_patterns(self) -> EngineManifest:
        if len(self.supported_patterns) != len(set(self.supported_patterns)):
            raise ValueError("duplicate_supported_pattern")
        allowed = _ENGINE_SUPPORTED_PATTERNS[self.name]
        if any(pattern not in allowed for pattern in self.supported_patterns):
            raise ValueError("unsupported_engine_pattern")
        return self


class ScannerFinding(StrictModel):
    engine: Literal["semgrep", "osv", "trivy"]
    rule_id: str = Field(min_length=1, max_length=256)
    kind: Literal["code", "dependency", "secret"]
    severity: Literal["info", "low", "medium", "high", "critical", "unknown"]
    path: str = Field(min_length=1, max_length=4096)
    line: int | None = Field(default=None, ge=1)
    package: str | None = Field(default=None, max_length=512)
    version: str | None = Field(default=None, max_length=256)
    symbol: str | None = Field(default=None, max_length=512)
    correlation_key: str | None = Field(default=None, max_length=256)
    observed: str = Field(default="", max_length=2000)

    @field_validator("path")
    @classmethod
    def safe_path(cls, value: str) -> str:
        if (
            value.startswith("/")
            or "\\" in value
            or any(part in {"", ".", ".."} for part in value.split("/"))
        ):
            raise ValueError("invalid_scanner_path")
        return value


_REQUIREMENTS_FILE = re.compile(r"(?:^|/)requirements(?:-[^/]+)?\.txt$|\.in$", re.IGNORECASE)
_REQUIREMENT_NAME = re.compile(r"^([A-Za-z0-9][A-Za-z0-9_.-]*)(?:\[[^\]]*\])?(.*)$")
_EXACT_REQUIREMENT = re.compile(r"^(?:===|==)\s*[0-9]+(?:\.[0-9]+)*(?:[A-Za-z0-9.+-]*)?$")
_SAFE_REQUIREMENT_SPEC = re.compile(r"^[A-Za-z0-9.*<>=!,~+\-\s]+$")
_PACKAGE_JSON_FILE = re.compile(r"(?:^|/)package\.json$", re.IGNORECASE)
_NPM_PACKAGE_NAME = re.compile(r"^(?:@[A-Za-z0-9_.-]+/)?[A-Za-z0-9_.-]+$")
_EXACT_NPM_SPEC = re.compile(r"^v?[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$")
_SAFE_NPM_SPEC = re.compile(r"^[A-Za-z0-9.*<>=!,~^+|\-\s]+$")
_NPM_RANGE_PREFIX = re.compile(r"^(?:v?[0-9]|[<>=~^*])")
_NPM_DEPENDENCY_FIELDS = (
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
)
_NPM_LOCKFILES = frozenset(
    {"package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"}
)


def _usable_npm_lockfile(name: str, source: str) -> bool:
    """Return whether a lockfile has enough structure to suppress manifest warnings."""

    if not source.strip():
        return False
    if name in {"package-lock.json", "npm-shrinkwrap.json"}:
        try:
            document = json.loads(source)
        except json.JSONDecodeError:
            return False
        if not isinstance(document, dict) or not isinstance(document.get("lockfileVersion"), int):
            return False
        packages = document.get("packages")
        if isinstance(packages, dict) and any(
            isinstance(path, str) and path.startswith("node_modules/") for path in packages
        ):
            return True
        dependencies = document.get("dependencies")
        return isinstance(dependencies, dict) and bool(dependencies)
    if name == "pnpm-lock.yaml":
        return bool(
            re.search(r"(?m)^\s*lockfileVersion\s*:\s*[\"']?\d", source)
            and re.search(r"(?m)^(?:importers|packages|snapshots)\s*:", source)
        )
    if name == "yarn.lock":
        return bool(
            re.search(r"(?im)^\s*#\s*yarn lockfile v\d+", source)
            and re.search(r"(?m)^[^#\s][^:\n]*:\s*$", source)
        )
    return False


def unresolved_dependency_findings(files: dict[str, str]) -> list[ScannerFinding]:
    """Surface dependencies whose version cannot be matched exactly.

    OSV-Scanner intentionally does not invent a version for an unpinned or
    ranged requirement.  Preserve that uncertainty as a candidate finding so
    a successful scan cannot be mistaken for a complete advisory check. Exact
    pins remain the responsibility of the advisory database result.
    """

    findings: list[ScannerFinding] = []
    for raw_path, source in files.items():
        if not isinstance(source, str) or not _REQUIREMENTS_FILE.search(raw_path):
            continue
        path = _normalize_path(raw_path)
        for line_number, raw_line in enumerate(source.splitlines(), 1):
            line = raw_line.split("#", 1)[0].split(";", 1)[0].strip()
            if not line or line.startswith("-"):
                continue
            match = _REQUIREMENT_NAME.fullmatch(line)
            if match is None:
                continue
            package, spec = match.groups()
            spec = re.split(r"\s+--hash(?:=|\s)", spec, maxsplit=1)[0]
            spec = spec.rstrip("\\").strip()
            if not spec:
                state = "unresolved"
                safe_spec = None
            elif _EXACT_REQUIREMENT.fullmatch(spec):
                continue
            else:
                state = "ranged"
                safe_spec = spec[:256] if _SAFE_REQUIREMENT_SPEC.fullmatch(spec) else None
            findings.append(
                ScannerFinding(
                    engine="osv",
                    rule_id=f"WK-OSV-{state.upper()}-DEPENDENCY",
                    kind="dependency",
                    severity="unknown",
                    path=path,
                    line=line_number,
                    package=package,
                    version=safe_spec,
                    correlation_key=f"osv-dependency-{state}:{path}:{package.lower()}",
                    observed=(
                        "Dependency version is not pinned; advisory matching is incomplete"
                        if state == "unresolved"
                        else "Dependency uses a version range; advisory matching is incomplete"
                    ),
                )
            )
            if len(findings) >= 50000:
                return findings
    npm_lock_directories = {
        Path(raw_path).parent.as_posix()
        for raw_path, source in files.items()
        if _usable_npm_lockfile(Path(raw_path).name.lower(), source)
    }
    for raw_path, source in files.items():
        if not isinstance(source, str) or not _PACKAGE_JSON_FILE.search(raw_path):
            continue
        if Path(raw_path).parent.as_posix() in npm_lock_directories:
            continue
        try:
            document = json.loads(source)
        except (json.JSONDecodeError, TypeError):
            continue
        if not isinstance(document, dict):
            continue
        path = _normalize_path(raw_path)
        seen_packages: set[str] = set()
        for field in _NPM_DEPENDENCY_FIELDS:
            values = document.get(field)
            if not isinstance(values, dict):
                continue
            for raw_package, raw_spec in values.items():
                if (
                    not isinstance(raw_package, str)
                    or not _NPM_PACKAGE_NAME.fullmatch(raw_package)
                    or raw_package in seen_packages
                    or not isinstance(raw_spec, str)
                ):
                    continue
                seen_packages.add(raw_package)
                spec = raw_spec.strip()
                if not spec or _EXACT_NPM_SPEC.fullmatch(spec):
                    continue
                safe_spec = spec[:256] if _SAFE_NPM_SPEC.fullmatch(spec) else None
                state = "ranged" if safe_spec and _NPM_RANGE_PREFIX.match(spec) else "unresolved"
                findings.append(
                    ScannerFinding(
                        engine="osv",
                        rule_id=f"WK-OSV-{state.upper()}-DEPENDENCY",
                        kind="dependency",
                        severity="unknown",
                        path=path,
                        package=raw_package,
                        version=safe_spec,
                        correlation_key=f"osv-dependency-{state}:{path}:{raw_package.lower()}",
                        observed=(
                            "Dependency version is not pinned; advisory matching is incomplete"
                            if state == "unresolved"
                            else "Dependency uses a version range; advisory matching is incomplete"
                        ),
                    )
                )
                if len(findings) >= 50000:
                    return findings
    return findings


class ScannerResult(StrictModel):
    engine: Literal["semgrep", "osv", "trivy"]
    status: Literal["completed", "incomplete", "error", "unavailable"]
    reason: str = Field(min_length=1, max_length=128)
    findings: list[ScannerFinding] = Field(max_length=50000)
    manifest: EngineManifest


class ScannerOutputError(ValueError):
    pass


class ScannerUnavailable(RuntimeError):
    pass


class ScannerExecutionError(RuntimeError):
    """Execution failure with a bounded, non-sensitive reason code."""

    def __init__(self, reason_code: str) -> None:
        self.reason_code = (
            reason_code
            if re.fullmatch(r"[a-z][a-z0-9_]{0,63}", reason_code, flags=re.ASCII)
            else "scanner_failed"
        )
        super().__init__(self.reason_code)


@dataclass(frozen=True)
class ScannerPlan:
    """An argv plan built only from plenger-managed identities and paths."""

    engine: EngineName
    executable: Path
    target_root: Path
    argv: tuple[str, ...]
    manifest: EngineManifest
    timeout_seconds: int = SCANNER_TIMEOUT_SECONDS
    runtime_home: Path | None = None
    provisioning: bool = False
    managed_rule_path: Path | None = None
    container_image: str | None = None
    container_name: str | None = None


FileIdentity = tuple[str, int, int, int, int, int]
_IDENTITY_CACHE_LIMIT = 64
_identity_cache_lock = threading.Lock()
_binary_hash_cache: dict[FileIdentity, str] = {}
_version_cache: dict[FileIdentity, str] = {}


def file_identity(path: Path) -> FileIdentity | None:
    """Identity that changes whenever file content could have changed.

    ``st_ctime_ns`` cannot be set by ordinary callers, so a rewrite that restores
    size and mtime still produces a different identity.
    """

    try:
        info = os.stat(path)
    except OSError:
        return None
    return (
        str(path),
        info.st_dev,
        info.st_ino,
        info.st_size,
        info.st_mtime_ns,
        info.st_ctime_ns,
    )


def _remember(cache: dict[FileIdentity, str], key: FileIdentity, value: str) -> None:
    with _identity_cache_lock:
        if len(cache) >= _IDENTITY_CACHE_LIMIT:
            cache.pop(next(iter(cache)))
        cache[key] = value


def _binary_hash(path: Path) -> str:
    before = file_identity(path)
    if before is not None:
        with _identity_cache_lock:
            cached = _binary_hash_cache.get(before)
        if cached is not None:
            return cached
    hasher = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            hasher.update(chunk)
    value = hasher.hexdigest()
    if before is not None and file_identity(path) == before:
        _remember(_binary_hash_cache, before, value)
    return value


def _managed_rule_path() -> Path:
    return Path(__file__).resolve().parent / "rules" / "semgrep.yml"


def plan_scanner(
    engine: EngineName,
    target_root: Path,
    *,
    expected_version: str,
    expected_binary_hash: str | None = None,
    executable: Path | None = None,
    managed_rule_path: Path | None = None,
    runtime_home: Path | None = None,
    container_image: str | None = None,
    provisioning: bool = False,
    timeout_seconds: int = SCANNER_TIMEOUT_SECONDS,
) -> ScannerPlan:
    """Build a pinned scanner invocation without reading target configuration.

    Version and binary hash are mandatory on purpose. Installing a same-named
    executable into PATH is not enough to make an optional engine trusted.
    """

    if not expected_version or len(expected_version) > 256:
        raise ValueError("scanner_version_pin_required")
    command: tuple[str, ...]
    if container_image is None:
        if (
            expected_binary_hash is None
            or len(expected_binary_hash) != 64
            or any(character not in "0123456789abcdef" for character in expected_binary_hash)
        ):
            raise ValueError("scanner_binary_hash_pin_required")
    elif expected_binary_hash is not None:
        raise ValueError("scanner_identity_modes_conflict")
    if container_image is not None and container_image != SCANNER_CONTAINER_IMAGES[engine]:
        raise ScannerUnavailable("scanner_container_image_not_allowed")
    root = target_root.resolve()
    if not root.is_dir():
        raise ValueError("scanner_target_root_invalid")
    if runtime_home is not None and not runtime_home.is_dir():
        raise ValueError("scanner_runtime_home_invalid")
    binary_name = {"semgrep": "semgrep", "osv": "osv-scanner", "trivy": "trivy"}[engine]
    if container_image is None:
        binary = (executable or Path(shutil.which(binary_name) or "")).resolve()
        if not binary.is_file():
            raise ScannerUnavailable("scanner_binary_missing")
        actual_hash = _binary_hash(binary)
        if actual_hash != expected_binary_hash:
            raise ScannerUnavailable("scanner_binary_hash_mismatch")
        actual_version = version_probe(binary)
        if actual_version is None or not actual_version.startswith(expected_version):
            raise ScannerUnavailable("scanner_version_mismatch")
        command = (str(binary),)
        target_argument = str(root)
    else:
        binary = Path("/__plenger_container__") / binary_name
        actual_hash = None
        actual_version = expected_version
        command = SCANNER_CONTAINER_COMMANDS[engine]
        target_argument = "/src"
    argv: tuple[str, ...]
    if engine == "semgrep":
        rules = (managed_rule_path or _managed_rule_path()).resolve()
        if not rules.is_file() or not rules.is_relative_to(Path(__file__).resolve().parent):
            raise ScannerUnavailable("managed_rules_missing_or_outside_package")
        argv = (
            *command,
            "--json",
            "--metrics=off",
            "--disable-version-check",
            "--config",
            "/rules/semgrep.yml" if container_image is not None else str(rules),
            target_argument,
        )
        schema = "semgrep-json-v1"
    elif engine == "osv":
        offline_flags = (
            ("--offline", "--download-offline-databases")
            if provisioning
            else ("--offline", "--offline-vulnerabilities")
        )
        argv = (
            *command,
            "scan",
            "source",
            "--format",
            "json",
            *offline_flags,
            "--no-resolve",
            "--allow-no-lockfiles",
            "--verbosity",
            "error",
            target_argument,
        )
        schema = "osv-json-v1"
    else:
        argv = (
            *command,
            "fs",
            "--format",
            "json",
            "--scanners",
            "secret",
            "--skip-db-update",
            "--skip-check-update",
            "--skip-version-check",
            "--no-progress",
            target_argument,
        )
        schema = "trivy-json-v1"
    manifest = _manifest(
        engine,
        schema,
        status="ready",
        engine_version=actual_version,
        binary_hash=actual_hash,
        image_digest=container_image,
        required_network="provisioning_only" if provisioning else "none",
    )
    if not 1 <= timeout_seconds <= 300:
        raise ValueError("scanner_timeout_invalid")
    return ScannerPlan(
        engine,
        binary,
        root,
        argv,
        manifest,
        timeout_seconds=timeout_seconds,
        runtime_home=runtime_home,
        provisioning=provisioning,
        managed_rule_path=rules if engine == "semgrep" else None,
        container_image=container_image,
        container_name=("plenger-scanner-" + uuid.uuid4().hex) if container_image else None,
    )


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


def _docker_environment() -> dict[str, str]:
    return {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": str(Path.home())}


def _docker_command() -> list[str]:
    docker = shutil.which("docker")
    if not docker:
        raise ScannerExecutionError("docker_missing")
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
            env=_docker_environment(),
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
            env=_docker_environment(),
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


def _container_execution_argv(plan: ScannerPlan, runtime_home: Path) -> list[str]:
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


def _cleanup_container(plan: ScannerPlan) -> None:
    if plan.container_name is None:
        return
    try:
        subprocess.run(
            [*_docker_command(), "container", "rm", "--force", plan.container_name],
            env=_docker_environment(),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=5,
            check=False,
        )
    except (OSError, ScannerExecutionError, subprocess.TimeoutExpired):
        pass


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
        return _container_execution_argv(plan, effective_runtime)
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


def _bounded_process(plan: ScannerPlan) -> bytes:
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
                _docker_environment()
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
            _cleanup_container(plan)
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
        raw = _bounded_process(plan)
        if plan.container_image is not None:
            raw = _map_container_output(raw, plan.engine)
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


def _bounded_json(raw: bytes | str) -> dict[str, Any]:
    encoded = raw.encode() if isinstance(raw, str) else raw
    if len(encoded) > MAX_OUTPUT_BYTES:
        raise ScannerOutputError("scanner_output_too_large")
    try:
        value = json.loads(encoded)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ScannerOutputError("malformed_scanner_output") from None
    if not isinstance(value, dict):
        raise ScannerOutputError("scanner_output_not_object")
    return value


def _container_relative_path(value: Any) -> Any:
    if value == "/src":
        raise ScannerOutputError("scanner_path_outside_target")
    if not isinstance(value, str) or not value.startswith("/src/"):
        return value
    relative = value.removeprefix("/src/")
    if not relative or any(part in {"", ".", ".."} for part in relative.split("/")):
        raise ScannerOutputError("invalid_scanner_path")
    return relative


def _map_container_output(raw: bytes | str, engine: EngineName) -> bytes:
    value = _bounded_json(raw)
    if engine == "semgrep":
        results = value.get("results")
        if isinstance(results, list):
            for result in results:
                if isinstance(result, dict) and "path" in result:
                    result["path"] = _container_relative_path(result["path"])
    elif engine == "osv":
        results = value.get("results")
        if isinstance(results, list):
            for result in results:
                if not isinstance(result, dict):
                    continue
                source = result.get("source")
                if isinstance(source, dict) and "path" in source:
                    source["path"] = _container_relative_path(source["path"])
    else:
        results = value.get("Results")
        if isinstance(results, list):
            for result in results:
                if isinstance(result, dict) and "Target" in result:
                    result["Target"] = _container_relative_path(result["Target"])
    return json.dumps(value, separators=(",", ":")).encode()


def _severity(value: Any) -> Severity:
    if not isinstance(value, str):
        return "unknown"
    value = value.lower()
    value = {"error": "high", "warning": "medium"}.get(value, value)
    return cast(
        Severity,
        value if value in {"info", "low", "medium", "high", "critical"} else "unknown",
    )


def _manifest(
    name: EngineName,
    schema: str,
    *,
    status: Literal[
        "unavailable", "unsupported_version", "blocked_by_policy", "ready"
    ] = "unavailable",
    engine_version: str | None = None,
    binary_hash: str | None = None,
    image_digest: str | None = None,
    required_network: Literal["none", "provisioning_only"] = "none",
) -> EngineManifest:
    licenses = {
        "semgrep": "engine:semgrep-ce;rules:managed-unverified",
        "osv": "engine:osv-scanner;db:local-unverified",
        "trivy": "engine:trivy;db:managed-unverified",
    }
    modes: dict[str, list[Literal["offline_static", "offline_db", "local_fixture"]]] = {
        "semgrep": ["offline_static", "local_fixture"],
        "osv": ["offline_db", "local_fixture"],
        "trivy": ["offline_static", "local_fixture"],
    }
    patterns: dict[EngineName, list[ScannerPattern]] = {
        "semgrep": ["python_ast_rules"],
        "osv": [
            "lockfile_advisories",
            "unresolved_dependency_advisories",
            "ranged_dependency_advisories",
        ],
        "trivy": ["filesystem_secrets"],
    }
    return EngineManifest(
        name=name,
        engine_version=engine_version,
        binary_hash=binary_hash,
        image_digest=image_digest,
        license_ref=licenses[name],
        output_schema=schema,
        supported_modes=modes[name],
        supported_patterns=patterns[name],
        required_network=required_network,
        status=status,
    )


def _normalize_path(raw: Any, base_dir: Path | None = None) -> str:
    if not isinstance(raw, str) or not raw:
        raise ScannerOutputError("invalid_scanner_path")
    candidate = Path(raw)
    if candidate.is_absolute():
        if base_dir is None:
            raise ScannerOutputError("invalid_scanner_path")
        try:
            candidate = candidate.resolve().relative_to(base_dir.resolve())
        except ValueError:
            raise ScannerOutputError("scanner_path_outside_target") from None
    else:
        candidate = Path(raw.removeprefix("./"))
        if base_dir is not None:
            base = base_dir.resolve()
            # Some engines report paths relative to the process cwd even when
            # their target argument is an absolute path. Resolve that form
            # only when the reported file is an existing regular file inside
            # the managed target; otherwise retain the relative contract for
            # synthetic output and fail closed below.
            for possible in (base / candidate, Path.cwd() / candidate):
                try:
                    resolved = possible.resolve()
                    if resolved.is_file() and resolved.is_relative_to(base):
                        candidate = resolved.relative_to(base)
                        break
                except OSError:
                    continue
    normalized = candidate.as_posix()
    if not normalized or normalized.startswith("../") or normalized == "..":
        raise ScannerOutputError("invalid_scanner_path")
    return normalized


def normalize_semgrep(raw: bytes | str, *, base_dir: Path | None = None) -> ScannerResult:
    value = _bounded_json(raw)
    results = value.get("results")
    if not isinstance(results, list) or len(results) > 50000:
        raise ScannerOutputError("invalid_semgrep_results")
    findings: list[ScannerFinding] = []
    for item in results:
        if not isinstance(item, dict):
            raise ScannerOutputError("invalid_semgrep_finding")
        start = item.get("start")
        path = _normalize_path(item.get("path"), base_dir)
        rule_id = item.get("check_id")
        if not isinstance(start, dict) or not isinstance(rule_id, str):
            raise ScannerOutputError("invalid_semgrep_finding")
        extra_value = item.get("extra")
        extra: dict[str, Any] = extra_value if isinstance(extra_value, dict) else {}
        metadata_value = extra.get("metadata")
        metadata: dict[str, Any] = metadata_value if isinstance(metadata_value, dict) else {}
        symbol = metadata.get(
            "plenger_symbol",
            metadata.get("wonderkit_symbol", metadata.get("symbol")),
        )
        correlation_key = metadata.get(
            "plenger_correlation_key", metadata.get("wonderkit_correlation_key")
        )
        findings.append(
            ScannerFinding(
                engine="semgrep",
                rule_id=rule_id,
                kind="code",
                severity=_severity(extra.get("severity")),
                path=path,
                line=start.get("line"),
                symbol=symbol if isinstance(symbol, str) else None,
                correlation_key=correlation_key if isinstance(correlation_key, str) else None,
                observed=str(redact(str(extra.get("message", ""))))[:2000],
            )
        )
    return ScannerResult(
        engine="semgrep",
        status="completed",
        reason="engine_completed",
        findings=findings,
        manifest=_manifest("semgrep", "semgrep-json-v1"),
    )


def _osv_advisory_alias_map(
    vulnerabilities: list[dict[str, Any]], groups: list[Any]
) -> dict[str, str]:
    """Map every OSV ID and alias to one deterministic advisory identity."""

    parent: dict[str, str] = {}

    def register(value: Any) -> str:
        if not isinstance(value, str) or not value.strip():
            raise ScannerOutputError("invalid_osv_advisory_id")
        normalized = value.strip().upper()
        parent.setdefault(normalized, normalized)
        return normalized

    def find(value: str) -> str:
        root = value
        while parent[root] != root:
            root = parent[root]
        while parent[value] != value:
            next_value = parent[value]
            parent[value] = root
            value = next_value
        return root

    def join(values: list[str]) -> None:
        first = values[0]
        for value in values[1:]:
            left = find(first)
            right = find(value)
            if left != right:
                parent[right] = left

    for vulnerability in vulnerabilities:
        identifier = register(vulnerability.get("id"))
        aliases = vulnerability.get("aliases", [])
        if not isinstance(aliases, list):
            raise ScannerOutputError("invalid_osv_aliases")
        identifiers = [identifier, *(register(alias) for alias in aliases)]
        join(identifiers)

    for group in groups:
        if not isinstance(group, dict):
            raise ScannerOutputError("invalid_osv_group")
        identifiers_value = group.get("ids", [])
        if not isinstance(identifiers_value, list) or not identifiers_value:
            raise ScannerOutputError("invalid_osv_group")
        identifiers = [register(identifier) for identifier in identifiers_value]
        join(identifiers)

    components: dict[str, set[str]] = {}
    for identifier in parent:
        components.setdefault(find(identifier), set()).add(identifier)
    canonical: dict[str, str] = {}
    for component in components.values():
        value = min(component)
        canonical.update({identifier: value for identifier in component})
    return canonical


def normalize_osv(raw: bytes | str, *, base_dir: Path | None = None) -> ScannerResult:
    value = _bounded_json(raw)
    results = value.get("results")
    if not isinstance(results, list) or len(results) > 50000:
        raise ScannerOutputError("invalid_osv_results")
    findings: list[ScannerFinding] = []
    for result in results:
        if not isinstance(result, dict):
            raise ScannerOutputError("invalid_osv_result")
        packages = result.get("packages", [])
        legacy_vulnerabilities = result.get("vulnerabilities", [])
        if not isinstance(packages, list) or not isinstance(legacy_vulnerabilities, list):
            raise ScannerOutputError("invalid_osv_result")
        source = result.get("source")
        source_path = source.get("path") if isinstance(source, dict) else None
        path = (
            _normalize_path(source_path, base_dir) if isinstance(source_path, str) else "lockfile"
        )
        package_entries: list[tuple[dict[str, Any], list[Any], list[Any]]] = []
        for package in packages:
            if not isinstance(package, dict):
                raise ScannerOutputError("invalid_osv_package")
            vulnerabilities = package.get("vulnerabilities", [])
            groups = package.get("groups", [])
            if not isinstance(vulnerabilities, list) or not isinstance(groups, list):
                raise ScannerOutputError("invalid_osv_package")
            package_entries.append((package, vulnerabilities, groups))
        if legacy_vulnerabilities:
            first = packages[0] if packages and isinstance(packages[0], dict) else {}
            package_entries.append((first, legacy_vulnerabilities, []))
        for package, vulnerabilities, groups in package_entries:
            typed_vulnerabilities: list[dict[str, Any]] = []
            for vulnerability in vulnerabilities:
                if (
                    not isinstance(vulnerability, dict)
                    or not isinstance(vulnerability.get("id"), str)
                    or not vulnerability["id"].strip()
                ):
                    raise ScannerOutputError("invalid_osv_vulnerability")
                typed_vulnerabilities.append(vulnerability)
            advisory_aliases = _osv_advisory_alias_map(typed_vulnerabilities, groups)
            info = package.get("package", {})
            name = info.get("name") if isinstance(info, dict) else None
            version = package.get("version")
            for vulnerability in typed_vulnerabilities:
                vulnerability_id = vulnerability["id"].strip()
                canonical_id = advisory_aliases.get(
                    vulnerability_id.upper(), vulnerability_id.upper()
                )
                findings.append(
                    ScannerFinding(
                        engine="osv",
                        rule_id=vulnerability_id,
                        kind="dependency",
                        severity="unknown",
                        path=path,
                        package=name if isinstance(name, str) else None,
                        version=version if isinstance(version, str) else None,
                        correlation_key=f"osv-advisory:{canonical_id}",
                        observed="Advisory matched in the local dependency database",
                    )
                )
    return ScannerResult(
        engine="osv",
        status="completed",
        reason="engine_completed",
        findings=findings,
        manifest=_manifest("osv", "osv-json-v1"),
    )


def normalize_trivy(raw: bytes | str, *, base_dir: Path | None = None) -> ScannerResult:
    value = _bounded_json(raw)
    results_value = value.get("Results")
    if results_value is None:
        if value.get("SchemaVersion") not in {1, 2} or not isinstance(
            value.get("ArtifactType"), str
        ):
            raise ScannerOutputError("invalid_trivy_results")
        results: list[Any] = []
    elif isinstance(results_value, list) and len(results_value) <= 50000:
        results = results_value
    else:
        raise ScannerOutputError("invalid_trivy_results")
    findings: list[ScannerFinding] = []
    for result in results:
        if not isinstance(result, dict):
            raise ScannerOutputError("invalid_trivy_result")
        target = _normalize_path(result.get("Target"), base_dir)
        secrets = result.get("Secrets", [])
        if not isinstance(secrets, list):
            raise ScannerOutputError("invalid_trivy_result")
        for secret in secrets:
            if not isinstance(secret, dict) or not isinstance(secret.get("RuleID"), str):
                raise ScannerOutputError("invalid_trivy_secret")
            findings.append(
                ScannerFinding(
                    engine="trivy",
                    rule_id=secret["RuleID"],
                    kind="secret",
                    severity=_severity(secret.get("Severity")),
                    path=target,
                    line=secret.get("StartLine"),
                    observed="Secret pattern detected; value intentionally omitted",
                )
            )
    return ScannerResult(
        engine="trivy",
        status="completed",
        reason="engine_completed",
        findings=findings,
        manifest=_manifest("trivy", "trivy-json-v1"),
    )


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


def _parse_version_output(raw: bytes) -> str | None:
    output = raw.decode("utf-8", errors="replace").strip()
    if not output:
        return None
    first_line = output.splitlines()[0].strip()
    for prefix in ("osv-scanner version: ", "Version: "):
        if first_line.startswith(prefix):
            return first_line.removeprefix(prefix)
    return first_line


def version_probe(binary: str | Path) -> str | None:
    """Read a bounded version string from a managed binary or allowed name."""

    identity: FileIdentity | None = None
    if isinstance(binary, Path):
        if not binary.is_file():
            return None
        executable = str(binary)
        identity = file_identity(binary)
        if identity is not None:
            with _identity_cache_lock:
                cached = _version_cache.get(identity)
            if cached is not None:
                return cached
    else:
        if binary not in {"semgrep", "osv-scanner", "trivy"}:
            raise ValueError("unsupported_scanner_binary")
        resolved = shutil.which(binary)
        if not resolved:
            return None
        executable = resolved
    for attempt in range(VERSION_PROBE_ATTEMPTS):
        try:
            result = subprocess.run(
                [executable, "--version"],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                env={"PATH": "/usr/local/bin:/usr/bin:/bin"},
                timeout=VERSION_PROBE_TIMEOUT_SECONDS,
                check=False,
            )
        except subprocess.TimeoutExpired:
            if attempt + 1 < VERSION_PROBE_ATTEMPTS:
                continue
            return None
        except OSError:
            return None
        if result.returncode != 0:
            return None
        version = _parse_version_output(result.stdout[:4096])
        if (
            version is not None
            and identity is not None
            and isinstance(binary, Path)
            and file_identity(binary) == identity
        ):
            _remember(_version_cache, identity, version)
        return version
    return None
