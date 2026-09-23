from plenger.adapters.correlation import correlate_findings, correlate_scanner_results
from plenger.adapters.scanners import ScannerFinding, ScannerResult


def _finding(**updates):
    values = {
        "engine": "semgrep",
        "rule_id": "python.eval",
        "kind": "code",
        "severity": "high",
        "path": "src/app.py",
        "line": 10,
        "observed": "dynamic execution",
    }
    values.update(updates)
    return ScannerFinding(**values)


def test_cross_engine_root_cause_keeps_all_evidence_and_raises_severity():
    result = correlate_findings(
        [
            _finding(engine="semgrep", correlation_key="python-eval-sink"),
            _finding(
                engine="trivy",
                rule_id="generic-secret",
                kind="secret",
                severity="critical",
                correlation_key="python-eval-sink",
            ),
        ]
    )
    assert len(result) == 1
    assert result[0].kind == "mixed"
    assert result[0].severity == "critical"
    assert result[0].engines == ["semgrep", "trivy"]
    assert len(result[0].evidence) == 2


def test_same_file_different_locations_or_rules_are_not_merged():
    result = correlate_findings(
        [
            _finding(line=10),
            _finding(line=11),
            _finding(rule_id="python.exec", line=10),
        ]
    )
    assert len(result) == 3


def test_symbol_identity_survives_line_shift_and_advisory_alias_is_explicit():
    code = correlate_findings(
        [
            _finding(line=10, symbol="handler"),
            _finding(line=42, symbol="handler"),
        ]
    )
    assert len(code) == 1
    advisories = correlate_findings(
        [
            _finding(
                engine="osv",
                rule_id="CVE-2026-0001",
                kind="dependency",
                path="uv.lock",
                line=None,
                package="demo",
                version="1.0",
            ),
            _finding(
                engine="osv",
                rule_id="GHSA-demo",
                kind="dependency",
                path="uv.lock",
                line=None,
                package="demo",
                version="1.0",
            ),
        ],
        advisory_aliases={"CVE-2026-0001": "DEMO-ADVISORY", "GHSA-DEMO": "DEMO-ADVISORY"},
    )
    assert len(advisories) == 1
    assert len(advisories[0].evidence) == 2


def test_incomplete_scanner_results_do_not_look_like_clean_findings():
    completed = ScannerResult(
        engine="semgrep",
        status="completed",
        reason="engine_completed",
        findings=[_finding()],
        manifest={
            "name": "semgrep",
            "license_ref": "managed",
            "output_schema": "semgrep-json-v1",
            "supported_modes": ["offline_static"],
            "supported_patterns": ["python_ast_rules"],
            "status": "ready",
        },
    )
    unavailable = completed.model_copy(
        update={"status": "unavailable", "findings": [], "reason": "binary_missing"}
    )
    assert len(correlate_scanner_results([completed, unavailable])) == 1
