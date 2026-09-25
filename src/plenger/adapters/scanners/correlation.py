"""Conservative cross-engine finding correlation.

Correlation is deliberately narrower than fingerprinting.  A correlation
cluster keeps every normalized scanner finding as evidence and only joins
records when the normalized adapter supplies an explicit root-cause key, or
when the fallback identity is exact enough to avoid merging unrelated issues
that happen to share a file.
"""

from __future__ import annotations

import hashlib
import json
from collections import defaultdict
from collections.abc import Iterable

from pydantic import Field

from plenger.adapters.scanners.models import ScannerFinding, ScannerResult
from plenger.domain.base import StrictModel


class CorrelatedFinding(StrictModel):
    """A cluster whose members remain available as individual evidence."""

    fingerprint: str = Field(pattern=r"^[a-f0-9]{64}$")
    kind: str = Field(min_length=1, max_length=32)
    severity: str = Field(min_length=1, max_length=16)
    path: str = Field(min_length=1, max_length=4096)
    line: int | None = Field(default=None, ge=1)
    symbol: str | None = Field(default=None, max_length=512)
    engines: list[str] = Field(min_length=1, max_length=3)
    rule_ids: list[str] = Field(min_length=1, max_length=50000)
    evidence: list[ScannerFinding] = Field(min_length=1, max_length=50000)
    match_basis: str = Field(min_length=1, max_length=64)


_SEVERITY_ORDER = {"unknown": -1, "info": 0, "low": 1, "medium": 2, "high": 3, "critical": 4}


def _normal(value: str) -> str:
    return " ".join(value.strip().lower().split())


def _advisory_id(value: str, aliases: dict[str, str]) -> str:
    normalized = value.strip().upper()
    return aliases.get(normalized, normalized)


def _group_key(
    finding: ScannerFinding,
    advisory_aliases: dict[str, str],
) -> tuple[tuple[str, ...], str]:
    """Return a key and a human-readable reason for the join.

    An explicit adapter-provided correlation key is the only way different
    scanner kinds can be grouped.  The fallback retains the scanner rule ID
    unless a stable symbol or dependency identity gives us a narrower key.
    """

    path = _normal(finding.path)
    if finding.correlation_key:
        if finding.kind == "dependency":
            return (
                "dependency",
                path,
                _normal(finding.package or ""),
                _normal(finding.version or ""),
                _normal(finding.correlation_key),
            ), "dependency_identity"
        return ("explicit", path, _normal(finding.correlation_key)), "explicit_root_cause"
    if finding.kind == "dependency":
        return (
            "dependency",
            path,
            _normal(finding.package or ""),
            _normal(finding.version or ""),
            _advisory_id(finding.rule_id, advisory_aliases),
        ), "dependency_identity"
    if finding.symbol:
        return (finding.kind, path, "symbol", _normal(finding.symbol)), "stable_symbol"
    return (
        finding.kind,
        path,
        "line",
        str(finding.line or 0),
        _normal(finding.rule_id),
    ), "exact_location"


def correlate_findings(
    findings: Iterable[ScannerFinding],
    *,
    advisory_aliases: dict[str, str] | None = None,
) -> list[CorrelatedFinding]:
    """Group only findings with a conservative normalized identity.

    ``advisory_aliases`` is explicit input from a managed compatibility
    manifest; the function never guesses that a CVE and GHSA describe the
    same advisory.  Every input remains in ``evidence``.
    """

    aliases = {
        str(source).strip().upper(): str(target).strip().upper()
        for source, target in (advisory_aliases or {}).items()
        if str(source).strip() and str(target).strip()
    }
    groups: dict[tuple[str, ...], list[ScannerFinding]] = defaultdict(list)
    bases: dict[tuple[str, ...], str] = {}
    for finding in findings:
        key, basis = _group_key(finding, aliases)
        groups[key].append(finding)
        bases[key] = basis

    correlated: list[CorrelatedFinding] = []
    for key, members in groups.items():
        first = members[0]
        severities = [item.severity for item in members]
        severity = max(severities, key=lambda item: _SEVERITY_ORDER[item])
        kinds = sorted({item.kind for item in members})
        symbols = {item.symbol for item in members if item.symbol}
        lines = [item.line for item in members if item.line is not None]
        identity = {
            "key": key,
            "engines": sorted({item.engine for item in members}),
            "rules": sorted({item.rule_id for item in members}),
        }
        fingerprint = hashlib.sha256(
            json.dumps(identity, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        correlated.append(
            CorrelatedFinding(
                fingerprint=fingerprint,
                kind=kinds[0] if len(kinds) == 1 else "mixed",
                severity=severity,
                path=first.path,
                line=min(lines) if lines else None,
                symbol=next(iter(symbols)) if len(symbols) == 1 else None,
                engines=sorted({item.engine for item in members}),
                rule_ids=sorted({item.rule_id for item in members}),
                evidence=members,
                match_basis=bases[key],
            )
        )
    return sorted(correlated, key=lambda item: (item.path, item.line or 0, item.fingerprint))


def correlate_scanner_results(
    results: Iterable[ScannerResult],
    *,
    advisory_aliases: dict[str, str] | None = None,
) -> list[CorrelatedFinding]:
    """Correlate findings from completed scanner results only.

    Error/unavailable engine states have no findings to merge; callers must
    retain their manifests and statuses separately as coverage evidence.
    """

    findings = [
        finding for result in results if result.status == "completed" for finding in result.findings
    ]
    return correlate_findings(findings, advisory_aliases=advisory_aliases)


__all__ = ["CorrelatedFinding", "correlate_findings", "correlate_scanner_results"]
