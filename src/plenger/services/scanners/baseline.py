"""Baseline runs of the managed scanners over an owner-only staging copy."""

from __future__ import annotations

import os
import stat
import tempfile
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from plenger.adapters.scanners.correlation import correlate_scanner_results
from plenger.adapters.scanners.dependencies import unresolved_dependency_findings
from plenger.adapters.scanners.execution import execute_scanner, scanner_isolation_mode
from plenger.adapters.scanners.models import (
    ScannerExecutionError,
    ScannerResult,
    ScannerUnavailable,
)
from plenger.adapters.scanners.planning import plan_scanner
from plenger.policy.redaction import redact
from plenger.services.scanners.database import database_home
from plenger.services.scanners.manifest import SCANNER_NAMES, entry_map, load_scanner_manifest
from plenger.services.scanners.verification import scanner_capabilities
from plenger.services.workspace import WorkspaceError
from plenger.storage.runs import digest


def _safe_stage_path(root: Path, relative: str) -> Path:
    candidate = Path(relative)
    if (
        not relative
        or candidate.is_absolute()
        or "\\" in relative
        or any(part in {"", ".", ".."} for part in candidate.parts)
    ):
        raise WorkspaceError("invalid_scanner_stage_path")
    resolved = (root / candidate).resolve()
    if not resolved.is_relative_to(root.resolve()):
        raise WorkspaceError("scanner_stage_path_outside_target")
    return resolved


@contextmanager
def _stage_files(files: dict[str, str]) -> Iterator[Path]:
    with tempfile.TemporaryDirectory(prefix="plenger-scanner-stage-") as temporary:
        root = Path(temporary)
        for relative, source in files.items():
            target = _safe_stage_path(root, relative)
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            descriptor = os.open(
                target,
                os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                0o600,
            )
            try:
                encoded = source.encode("utf-8")
                view = memoryview(encoded)
                while view:
                    written = os.write(descriptor, view)
                    if written <= 0:
                        raise WorkspaceError("scanner_stage_write_failed")
                    view = view[written:]
                os.fsync(descriptor)
                os.lseek(descriptor, 0, os.SEEK_SET)
                verified = bytearray()
                while len(verified) <= len(encoded):
                    chunk = os.read(descriptor, min(65536, len(encoded) + 1 - len(verified)))
                    if not chunk:
                        break
                    verified.extend(chunk)
                info = os.fstat(descriptor)
                if (
                    bytes(verified) != encoded
                    or not stat.S_ISREG(info.st_mode)
                    or info.st_nlink != 1
                    or info.st_uid != os.getuid()
                    or info.st_size != len(encoded)
                ):
                    raise WorkspaceError("scanner_stage_copy_changed")
            finally:
                os.close(descriptor)
        yield root


def run_managed_scanners(
    root: Path, files: dict[str, str]
) -> tuple[list[ScannerResult], dict[str, dict[str, str]]]:
    """Run configured engines against an owner-only capture staging directory."""

    states = scanner_capabilities(root)
    manifest = load_scanner_manifest(root)
    if manifest is None:
        return [], states
    entries = entry_map(manifest)
    results: list[ScannerResult] = []
    with _stage_files(files) as staged:
        for name in SCANNER_NAMES:
            entry = entries.get(name)
            if entry is None or states[name].get("status") != "ready":
                continue
            runtime_home = database_home(root, create=False) if name == "osv" else None
            try:
                if entry.container_image is not None:
                    plan = plan_scanner(
                        name,
                        staged,
                        expected_version=entry.version,
                        container_image=entry.container_image,
                        runtime_home=runtime_home,
                    )
                else:
                    if entry.binary_hash is None or entry.executable is None:
                        raise ScannerUnavailable("managed_binary_identity_missing")
                    plan = plan_scanner(
                        name,
                        staged,
                        expected_version=entry.version,
                        expected_binary_hash=entry.binary_hash,
                        executable=Path(entry.executable),
                        runtime_home=runtime_home,
                    )
                result = execute_scanner(plan)
                if name == "osv" and result.status == "completed":
                    unresolved = unresolved_dependency_findings(files)
                    if unresolved:
                        result = result.model_copy(
                            update={"findings": [*result.findings, *unresolved]}
                        )
            except (OSError, ScannerExecutionError, ScannerUnavailable, ValueError) as exc:
                states[name] = {
                    "status": "error",
                    "reason": str(exc)[:128],
                    "isolation": states[name].get("isolation", scanner_isolation_mode()),
                }
                continue
            results.append(result)
            states[name] = {
                "status": result.status,
                "reason": result.reason,
                "version": entry.version,
                "isolation": states[name].get("isolation", scanner_isolation_mode()),
            }
    return results, states


def scanner_findings_to_report(results: Sequence[ScannerResult]) -> list[dict[str, Any]]:
    """Convert normalized scanner evidence to the report finding contract."""

    findings: list[dict[str, Any]] = []
    for correlated in correlate_scanner_results(results):
        evidence_items: list[dict[str, Any]] = []
        for member in correlated.evidence:
            observed = str(redact(member.observed))[:2000]
            evidence_items.append(
                {
                    "id": digest(
                        [
                            "scanner-evidence",
                            member.engine,
                            member.rule_id,
                            member.path,
                            member.line,
                            observed,
                        ]
                    ),
                    "source": f"{member.engine}-scanner-v1",
                    "observed": observed,
                    "redaction_version": "scanner-normalized-v1",
                }
            )
        if not evidence_items:
            continue
        finding: dict[str, Any] = {
            "id": correlated.fingerprint,
            "fingerprint": correlated.fingerprint,
            "rule_id": ",".join(correlated.rule_ids)[:256],
            "kind": correlated.kind,
            "severity": correlated.severity,
            "severity_source": "scanner:" + ",".join(correlated.engines),
            "validation_state": "candidate",
            "lifecycle_state": "open",
            "assessment_state": "needs_review",
            "title": f"Kandidat {correlated.kind} dari {', '.join(correlated.engines)}",
            "source_ref": {"path": correlated.path, "line": correlated.line or 1},
            "evidence": evidence_items[0],
        }
        if len(evidence_items) > 1:
            finding["evidence_refs"] = evidence_items
        findings.append(finding)
    return findings
