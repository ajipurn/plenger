"""Candidate findings for dependencies an advisory database cannot match exactly."""

from __future__ import annotations

import json
import re
from pathlib import Path

from plenger.adapters.scanners.models import ScannerFinding
from plenger.adapters.scanners.normalize import normalize_path

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
        path = normalize_path(raw_path)
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
        path = normalize_path(raw_path)
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
