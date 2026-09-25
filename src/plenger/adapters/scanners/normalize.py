"""Bounded, fail-closed normalization of scanner JSON output."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, cast

from plenger.adapters.scanners.models import (
    MAX_OUTPUT_BYTES,
    EngineName,
    ScannerFinding,
    ScannerOutputError,
    ScannerResult,
    Severity,
    build_manifest,
)
from plenger.policy.redaction import redact


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


def map_container_output(raw: bytes | str, engine: EngineName) -> bytes:
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


def normalize_path(raw: Any, base_dir: Path | None = None) -> str:
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
        path = normalize_path(item.get("path"), base_dir)
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
        manifest=build_manifest("semgrep", "semgrep-json-v1"),
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
        canonical.update(dict.fromkeys(component, value))
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
        path = normalize_path(source_path, base_dir) if isinstance(source_path, str) else "lockfile"
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
        manifest=build_manifest("osv", "osv-json-v1"),
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
        target = normalize_path(result.get("Target"), base_dir)
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
        manifest=build_manifest("trivy", "trivy-json-v1"),
    )
