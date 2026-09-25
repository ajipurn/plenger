"""Normalized scanner contracts: engine manifests, findings, results and plans."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from pydantic import Field, field_validator, model_validator

from plenger.domain.base import StrictModel

MAX_OUTPUT_BYTES = 64 * 1024 * 1024
SCANNER_TIMEOUT_SECONDS = 120

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


def build_manifest(
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
