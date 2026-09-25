"""Pinned scanner invocations built only from plenger-managed identities."""

from __future__ import annotations

import shutil
import uuid
from pathlib import Path

from plenger.adapters.scanners.binaries import hash_binary, version_probe
from plenger.adapters.scanners.containers import (
    SCANNER_CONTAINER_COMMANDS,
    SCANNER_CONTAINER_IMAGES,
)
from plenger.adapters.scanners.models import (
    SCANNER_TIMEOUT_SECONDS,
    EngineName,
    ScannerPlan,
    ScannerUnavailable,
    build_manifest,
)


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
        actual_hash = hash_binary(binary)
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
    manifest = build_manifest(
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
