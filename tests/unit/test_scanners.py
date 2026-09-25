import hashlib
import json
import subprocess
from dataclasses import replace

import pytest
from pydantic import ValidationError

from plenger.adapters.scanners.binaries import VERSION_PROBE_ATTEMPTS, version_probe
from plenger.adapters.scanners.containers import (
    SCANNER_CONTAINER_IMAGES,
    SCANNER_CONTAINER_MEMORY,
    pull_container_image,
)
from plenger.adapters.scanners.correlation import correlate_scanner_results
from plenger.adapters.scanners.dependencies import unresolved_dependency_findings
from plenger.adapters.scanners.execution import _execution_argv, execute_scanner
from plenger.adapters.scanners.models import (
    EngineManifest,
    ScannerOutputError,
    ScannerResult,
    ScannerUnavailable,
)
from plenger.adapters.scanners.normalize import normalize_osv, normalize_semgrep, normalize_trivy
from plenger.adapters.scanners.planning import plan_scanner
from plenger.services.scanners import (
    ManagedScanner,
    ManagedScannerManifest,
    run_managed_scanners,
    save_scanner_manifest,
)
from plenger.services.workspace import initialize


def test_scanner_normalizers_preserve_source_and_redact_secret_value(tmp_path):
    semgrep = normalize_semgrep(
        json.dumps(
            {
                "results": [
                    {
                        "check_id": "python.eval",
                        "path": "src/app.py",
                        "start": {"line": 4},
                        "extra": {
                            "severity": "ERROR",
                            "message": "eval sink token=sk-secret-SYNTHETIC0123456789",
                        },
                    }
                ]
            }
        )
    )
    assert semgrep.findings[0].severity == "high"
    assert semgrep.findings[0].path == "src/app.py"
    assert "SYNTHETIC" not in semgrep.findings[0].observed

    osv = normalize_osv(
        json.dumps(
            {
                "results": [
                    {
                        "packages": [{"package": {"name": "demo"}, "version": "1.0"}],
                        "vulnerabilities": [{"id": "GHSA-demo"}],
                    }
                ]
            }
        )
    )
    assert osv.findings[0].package == "demo"

    nested_osv = normalize_osv(
        json.dumps(
            {
                "results": [
                    {
                        "source": {"path": str(tmp_path / "uv.lock"), "type": "lockfile"},
                        "packages": [
                            {
                                "package": {"name": "demo", "ecosystem": "PyPI"},
                                "version": "1.0",
                                "vulnerabilities": [{"id": "CVE-demo"}],
                            }
                        ],
                    }
                ]
            }
        ),
        base_dir=tmp_path,
    )
    assert nested_osv.findings[0].rule_id == "CVE-demo"

    trivy = normalize_trivy(
        json.dumps(
            {
                "Results": [
                    {
                        "Target": "src/config.py",
                        "Secrets": [
                            {
                                "RuleID": "generic-api-key",
                                "Severity": "HIGH",
                                "StartLine": 8,
                                "Match": "sk-secret-SYNTHETIC0123456789",
                            }
                        ],
                    }
                ]
            }
        )
    )
    assert "SYNTHETIC" not in trivy.findings[0].observed


def test_engine_manifest_rejects_duplicate_or_wrong_engine_patterns():
    base = {
        "name": "semgrep",
        "license_ref": "managed",
        "output_schema": "semgrep-json-v1",
        "supported_modes": ["offline_static"],
        "status": "ready",
    }
    with pytest.raises(ValidationError, match="duplicate_supported_pattern"):
        EngineManifest(
            **base,
            supported_patterns=["python_ast_rules", "python_ast_rules"],
        )
    with pytest.raises(ValidationError, match="unsupported_engine_pattern"):
        EngineManifest(
            **base,
            supported_patterns=["filesystem_secrets"],
        )


def test_osv_aliases_canonicalize_without_dropping_advisory_evidence():
    result = normalize_osv(
        json.dumps(
            {
                "results": [
                    {
                        "source": {"path": "uv.lock", "type": "lockfile"},
                        "packages": [
                            {
                                "package": {"name": "demo", "ecosystem": "PyPI"},
                                "version": "1.0",
                                "vulnerabilities": [
                                    {"id": "GHSA-demo", "aliases": ["CVE-2026-0001"]},
                                    {"id": "CVE-2026-0001", "aliases": ["GHSA-demo"]},
                                ],
                                "groups": [{"ids": ["GHSA-demo", "CVE-2026-0001"]}],
                            }
                        ],
                    }
                ]
            }
        ),
    )

    assert len(result.findings) == 2
    assert {finding.rule_id for finding in result.findings} == {
        "GHSA-demo",
        "CVE-2026-0001",
    }
    assert {finding.correlation_key for finding in result.findings} == {
        "osv-advisory:CVE-2026-0001"
    }
    correlated = correlate_scanner_results([result])
    assert len(correlated) == 1
    assert correlated[0].rule_ids == ["CVE-2026-0001", "GHSA-demo"]
    assert len(correlated[0].evidence) == 2


def test_osv_vulnerable_dependency_without_version_remains_visible():
    result = normalize_osv(
        json.dumps(
            {
                "results": [
                    {
                        "source": {"path": "requirements.txt", "type": "lockfile"},
                        "packages": [
                            {
                                "package": {"name": "unresolved-demo"},
                                "vulnerabilities": [{"id": "OSV-UNRESOLVED"}],
                            },
                            {
                                "package": {"name": "ranged-demo"},
                                "version": ">=1.0,<2.0",
                                "vulnerabilities": [{"id": "OSV-RANGED"}],
                            },
                        ],
                    }
                ]
            }
        )
    )

    assert len(result.findings) == 2
    assert result.findings[0].package == "unresolved-demo"
    assert result.findings[0].version is None
    assert result.findings[1].package == "ranged-demo"
    assert result.findings[1].version == ">=1.0,<2.0"


def test_unresolved_dependency_requirements_are_explicit_candidates_without_raw_urls():
    findings = unresolved_dependency_findings(
        {
            "requirements.txt": (
                "requests==2.31.0 \\\n"
                "--hash=sha256:abc\n"
                "unresolved-demo\n"
                "ranged-demo>=1.0,<2.0\n"
                "source-demo @ https://example.invalid/source.tar.gz\n"
            )
        }
    )

    assert [finding.package for finding in findings] == [
        "unresolved-demo",
        "ranged-demo",
        "source-demo",
    ]
    assert [finding.rule_id for finding in findings] == [
        "WK-OSV-UNRESOLVED-DEPENDENCY",
        "WK-OSV-RANGED-DEPENDENCY",
        "WK-OSV-RANGED-DEPENDENCY",
    ]
    assert findings[0].version is None
    assert findings[1].version == ">=1.0,<2.0"
    assert findings[2].version is None
    assert "example.invalid" not in findings[2].model_dump_json()


def test_unresolved_dependency_package_json_specs_are_explicit_and_lock_aware():
    findings = unresolved_dependency_findings(
        {
            "package.json": json.dumps(
                {
                    "dependencies": {
                        "react": "^19.3.0",
                        "exact-demo": "19.3.0",
                        "source-demo": "git+https://example.invalid/source.git",
                    },
                    "optionalDependencies": {"react": "^19.3.0"},
                }
            )
        }
    )

    assert [finding.package for finding in findings] == ["react", "source-demo"]
    assert [finding.rule_id for finding in findings] == [
        "WK-OSV-RANGED-DEPENDENCY",
        "WK-OSV-UNRESOLVED-DEPENDENCY",
    ]
    assert findings[0].version == "^19.3.0"
    assert findings[1].version is None
    assert "example.invalid" not in findings[1].model_dump_json()
    assert (
        unresolved_dependency_findings(
            {
                "package.json": '{"dependencies":{"react":"^19.3.0"}}',
                "package-lock.json": json.dumps(
                    {
                        "lockfileVersion": 3,
                        "packages": {
                            "": {"name": "fixture", "version": "1.0.0"},
                            "node_modules/react": {"version": "19.3.0"},
                        },
                    }
                ),
            }
        )
        == []
    )


@pytest.mark.parametrize(
    ("lockfile", "source"),
    [
        (
            "npm-shrinkwrap.json",
            json.dumps(
                {
                    "lockfileVersion": 3,
                    "packages": {"node_modules/react": {"version": "19.3.0"}},
                }
            ),
        ),
        (
            "pnpm-lock.yaml",
            (
                "lockfileVersion: '9.0'\n"
                "importers:\n"
                "  .:\n"
                "    dependencies:\n"
                "      react:\n"
                "        specifier: ^19.3.0\n"
                "        version: 19.3.0\n"
                "packages:\n"
                "  react@19.3.0: {}\n"
            ),
        ),
        (
            "yarn.lock",
            '# yarn lockfile v1\n\nreact@^19.3.0:\n  version "19.3.0"\n',
        ),
    ],
)
def test_unresolved_dependency_package_json_accepts_supported_lockfile_shapes(lockfile, source):
    assert (
        unresolved_dependency_findings(
            {
                "web/package.json": '{"dependencies":{"react":"^19.3.0"}}',
                f"web/{lockfile}": source,
            }
        )
        == []
    )
    findings = unresolved_dependency_findings(
        {
            "web/package.json": '{"dependencies":{"react":"^19.3.0"}}',
            f"web/{lockfile}": "malformed lockfile",
        }
    )
    assert [finding.rule_id for finding in findings] == ["WK-OSV-RANGED-DEPENDENCY"]


def test_managed_osv_scan_adds_unresolved_candidates_after_engine_completion(tmp_path, monkeypatch):
    initialize(tmp_path)
    save_scanner_manifest(
        tmp_path,
        ManagedScannerManifest(
            engines=[
                ManagedScanner(
                    name="osv",
                    version="2.6.0",
                    container_image=SCANNER_CONTAINER_IMAGES["osv"],
                )
            ]
        ),
    )
    monkeypatch.setattr(
        "plenger.services.scanners.scanner_capabilities",
        lambda root: {
            "semgrep": {"status": "unavailable", "reason": "not_configured"},
            "osv": {"status": "ready", "reason": "test", "isolation": "test"},
            "trivy": {"status": "unavailable", "reason": "not_configured"},
        },
    )
    monkeypatch.setattr(
        "plenger.services.scanners.execute_scanner",
        lambda plan: ScannerResult(
            engine="osv",
            status="completed",
            reason="engine_completed",
            findings=[],
            manifest=plan.manifest,
        ),
    )

    results, states = run_managed_scanners(tmp_path, {"requirements.txt": "requests>=2.0,<3.0\n"})

    assert states["osv"]["status"] == "completed"
    assert len(results) == 1
    assert results[0].findings[0].rule_id == "WK-OSV-RANGED-DEPENDENCY"
    assert results[0].findings[0].severity == "unknown"


@pytest.mark.parametrize(
    "payload",
    [
        '{"results":[{"path":"../secret.py","check_id":"x","start":{"line":1}}]}',
        '{"results":[{"Target":"../secret.py","Secrets":[]}]}',
        "[]",
    ],
)
def test_scanner_output_is_fail_closed(payload):
    with pytest.raises((ScannerOutputError, ValueError)):
        normalize_semgrep(payload)


def test_scanner_plan_requires_pinned_binary_and_uses_managed_rules(tmp_path, monkeypatch):
    binary = tmp_path / "semgrep"
    binary.write_bytes(b"managed-semgrep")
    target_override = tmp_path / "semgrep.yml"
    target_override.write_text("rules: []\n")
    binary_hash = hashlib.sha256(binary.read_bytes()).hexdigest()
    monkeypatch.setattr("plenger.adapters.scanners.planning.version_probe", lambda name: "1.2.3")
    plan = plan_scanner(
        "semgrep",
        tmp_path,
        expected_version="1.2",
        expected_binary_hash=binary_hash,
        executable=binary,
    )
    assert plan.manifest.status == "ready"
    assert plan.manifest.supported_patterns == ["python_ast_rules"]
    assert "--metrics=off" in plan.argv
    assert "--config" in plan.argv
    config_path = plan.argv[plan.argv.index("--config") + 1]
    assert config_path == str(plan.managed_rule_path)
    assert config_path != str(target_override)
    with pytest.raises(ScannerUnavailable, match="managed_rules_missing_or_outside_package"):
        plan_scanner(
            "semgrep",
            tmp_path,
            expected_version="1.2",
            expected_binary_hash=binary_hash,
            executable=binary,
            managed_rule_path=target_override,
        )
    with pytest.raises(ScannerUnavailable, match="hash_mismatch"):
        plan_scanner(
            "semgrep",
            tmp_path,
            expected_version="1.2",
            expected_binary_hash="0" * 64,
            executable=binary,
        )


def test_container_scanner_plan_is_digest_pinned_and_mounts_only_managed_inputs(
    tmp_path, monkeypatch
):
    plan = plan_scanner(
        "semgrep",
        tmp_path,
        expected_version="1.176.0",
        container_image=SCANNER_CONTAINER_IMAGES["semgrep"],
    )
    monkeypatch.setattr(
        "plenger.adapters.scanners.containers._docker_command",
        lambda: ["docker", "--host", "unix:///var/run/docker.sock"],
    )
    monkeypatch.setattr(
        "plenger.adapters.scanners.containers._container_user",
        lambda: "501:20",
    )

    argv = _execution_argv(plan)

    assert plan.manifest.image_digest == SCANNER_CONTAINER_IMAGES["semgrep"]
    assert plan.manifest.binary_hash is None
    assert "--network=none" in argv
    assert "--read-only" in argv
    assert "512m" in argv
    assert "--cap-drop=ALL" in argv
    assert "--security-opt=no-new-privileges" in argv
    assert "501:20" in argv
    assert f"type=bind,source={tmp_path},target=/src,readonly" in argv
    assert "target=/rules/semgrep.yml,readonly" in " ".join(argv)
    assert "--config" in plan.argv
    assert "/src" in plan.argv
    assert plan.container_name is not None

    with pytest.raises(ValueError, match="scanner_identity_modes_conflict"):
        plan_scanner(
            "semgrep",
            tmp_path,
            expected_version="1.176.0",
            expected_binary_hash="a" * 64,
            container_image=SCANNER_CONTAINER_IMAGES["semgrep"],
        )


def test_pull_container_image_uses_only_configured_digest(monkeypatch):
    image = SCANNER_CONTAINER_IMAGES["semgrep"]
    calls: list[list[str]] = []
    monkeypatch.setattr(
        "plenger.adapters.scanners.containers._docker_command",
        lambda: ["docker", "--host", "unix:///var/run/docker.sock"],
    )

    def run(argv, **kwargs):
        calls.append(argv)
        return subprocess.CompletedProcess(argv, 0, b"", b"")

    monkeypatch.setattr("plenger.adapters.scanners.containers.subprocess.run", run)
    monkeypatch.setattr(
        "plenger.adapters.scanners.containers.container_image_present", lambda value: value == image
    )

    assert pull_container_image(image) == (True, "container_image_pulled")
    assert calls == [["docker", "--host", "unix:///var/run/docker.sock", "pull", "--quiet", image]]
    assert pull_container_image("example.invalid/scanner@sha256:" + "a" * 64) == (
        False,
        "container_image_not_allowed",
    )


def test_osv_scan_plan_is_offline_and_never_downloads(tmp_path, monkeypatch):
    binary = tmp_path / "osv-scanner"
    binary.write_bytes(b"managed-osv")
    binary_hash = hashlib.sha256(binary.read_bytes()).hexdigest()
    monkeypatch.setattr("plenger.adapters.scanners.planning.version_probe", lambda name: "2.6.0")

    plan = plan_scanner(
        "osv",
        tmp_path,
        expected_version="2.6.0",
        expected_binary_hash=binary_hash,
        executable=binary,
    )

    assert "--offline" in plan.argv
    assert "--offline-vulnerabilities" in plan.argv
    assert "--download-offline-databases" not in plan.argv
    assert SCANNER_CONTAINER_MEMORY["osv"] == "1g"
    assert plan.manifest.supported_patterns == [
        "lockfile_advisories",
        "unresolved_dependency_advisories",
        "ranged_dependency_advisories",
    ]
    assert not plan.provisioning


def test_osv_provisioning_plan_is_explicitly_network_capable(tmp_path, monkeypatch):
    binary = tmp_path / "osv-scanner"
    binary.write_bytes(b"managed-osv")
    binary_hash = hashlib.sha256(binary.read_bytes()).hexdigest()
    monkeypatch.setattr("plenger.adapters.scanners.planning.version_probe", lambda name: "2.6.0")
    monkeypatch.setattr("plenger.adapters.scanners.execution.platform.system", lambda: "Darwin")
    monkeypatch.setattr(
        "plenger.adapters.scanners.execution.shutil.which",
        lambda name: "/usr/bin/sandbox-exec" if name == "sandbox-exec" else None,
    )
    plan = plan_scanner(
        "osv",
        tmp_path,
        expected_version="2.6.0",
        expected_binary_hash=binary_hash,
        executable=binary,
        provisioning=True,
    )

    profile = _execution_argv(plan, tmp_path)[2]

    assert plan.provisioning
    assert plan.manifest.required_network == "provisioning_only"
    assert plan.manifest.supported_patterns == [
        "lockfile_advisories",
        "unresolved_dependency_advisories",
        "ranged_dependency_advisories",
    ]
    assert "(allow network-outbound)" in profile
    assert "(deny network*)" not in profile


def test_darwin_scanner_argv_uses_default_deny_seatbelt(tmp_path, monkeypatch):
    binary = tmp_path / "trivy"
    binary.write_bytes(b"managed-trivy")
    binary_hash = hashlib.sha256(binary.read_bytes()).hexdigest()
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    monkeypatch.setattr("plenger.adapters.scanners.planning.version_probe", lambda name: "0.1.0")
    monkeypatch.setattr("plenger.adapters.scanners.execution.platform.system", lambda: "Darwin")
    monkeypatch.setattr(
        "plenger.adapters.scanners.execution.shutil.which",
        lambda name: "/usr/bin/sandbox-exec" if name == "sandbox-exec" else None,
    )
    plan = plan_scanner(
        "trivy",
        tmp_path,
        expected_version="0.1",
        expected_binary_hash=binary_hash,
        executable=binary,
        runtime_home=runtime,
    )

    argv = _execution_argv(plan, runtime)

    assert argv[:2] == ["/usr/bin/sandbox-exec", "-p"]
    assert "(deny default)" in argv[2]
    assert "(deny network*)" in argv[2]
    assert str(runtime) in argv[2]
    assert str(tmp_path) in argv[2]
    assert plan.manifest.supported_patterns == ["filesystem_secrets"]


def test_non_darwin_host_scanner_argv_requires_container_worker(tmp_path, monkeypatch):
    binary = tmp_path / "trivy"
    binary.write_bytes(b"managed-trivy")
    binary_hash = hashlib.sha256(binary.read_bytes()).hexdigest()
    monkeypatch.setattr("plenger.adapters.scanners.planning.version_probe", lambda name: "0.1.0")
    monkeypatch.setattr("plenger.adapters.scanners.execution.platform.system", lambda: "Linux")
    plan = plan_scanner(
        "trivy",
        tmp_path,
        expected_version="0.1",
        expected_binary_hash=binary_hash,
        executable=binary,
    )

    with pytest.raises(RuntimeError, match="container_worker_required"):
        _execution_argv(plan)


def test_version_probe_uses_explicit_managed_binary(tmp_path):
    binary = tmp_path / "managed-semgrep"
    binary.write_text("#!/bin/sh\nprintf '1.2.3\\n'\n")
    binary.chmod(0o700)
    assert version_probe(binary) == "1.2.3"


def test_version_probe_retries_a_transient_timeout(monkeypatch, tmp_path):
    binary = tmp_path / "managed-semgrep"
    binary.write_text("#!/bin/sh\n")
    calls = 0

    def run(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise subprocess.TimeoutExpired(args[0], kwargs["timeout"])
        return subprocess.CompletedProcess(args[0], 0, b"1.2.3\n", b"")

    monkeypatch.setattr("plenger.adapters.scanners.binaries.subprocess.run", run)
    assert version_probe(binary) == "1.2.3"
    assert calls == min(2, VERSION_PROBE_ATTEMPTS)


def test_managed_scanner_revalidation_failure_becomes_bounded_error(tmp_path, monkeypatch):
    executable = tmp_path / "managed-semgrep"
    manifest = ManagedScannerManifest(
        engines=[
            ManagedScanner(
                name="semgrep",
                executable=str(executable),
                version="1.2.3",
                binary_hash="a" * 64,
            )
        ]
    )
    monkeypatch.setattr("plenger.services.scanners.load_scanner_manifest", lambda root: manifest)
    monkeypatch.setattr(
        "plenger.services.scanners.scanner_capabilities",
        lambda root: {
            "semgrep": {"status": "ready", "isolation": "test"},
            "osv": {"status": "unavailable", "isolation": "test"},
            "trivy": {"status": "unavailable", "isolation": "test"},
        },
    )

    def unavailable(*args, **kwargs):
        raise ScannerUnavailable("scanner_version_mismatch")

    monkeypatch.setattr("plenger.services.scanners.plan_scanner", unavailable)
    results, states = run_managed_scanners(tmp_path, {"app.py": "pass\n"})

    assert results == []
    assert states["semgrep"]["status"] == "error"
    assert states["semgrep"]["reason"] == "scanner_version_mismatch"


def test_scanner_execution_maps_target_paths_and_fails_closed(monkeypatch, tmp_path):
    binary = tmp_path / "trivy"
    binary.write_bytes(b"managed-trivy")
    binary_hash = hashlib.sha256(binary.read_bytes()).hexdigest()
    monkeypatch.setattr("plenger.adapters.scanners.planning.version_probe", lambda name: "0.1.0")
    plan = plan_scanner(
        "trivy",
        tmp_path,
        expected_version="0.1",
        expected_binary_hash=binary_hash,
        executable=binary,
    )
    monkeypatch.setattr(
        "plenger.adapters.scanners.execution.run_scanner_process",
        lambda current: json.dumps(
            {
                "Results": [
                    {
                        "Target": str(tmp_path / "config.py"),
                        "Secrets": [{"RuleID": "synthetic", "Severity": "HIGH", "StartLine": 2}],
                    }
                ]
            }
        ).encode(),
    )
    result = execute_scanner(plan)
    assert result.status == "completed"
    assert result.findings[0].path == "config.py"

    monkeypatch.setattr(
        "plenger.adapters.scanners.execution.run_scanner_process",
        lambda current: b'{"invalid": true}',
    )
    failed = execute_scanner(plan)
    assert failed.status == "error" and failed.reason == "invalid_trivy_results"


@pytest.mark.parametrize(
    ("script", "expected_reason"),
    [
        ("exit 7", "scanner_failed"),
        ("printf ''", "scanner_empty_output"),
        ("printf '{'", "malformed_scanner_output"),
    ],
)
def test_scanner_execution_rejects_failed_or_empty_process_output(
    monkeypatch, tmp_path, script, expected_reason
):
    binary = tmp_path / "trivy"
    binary.write_bytes(b"managed-trivy")
    binary_hash = hashlib.sha256(binary.read_bytes()).hexdigest()
    monkeypatch.setattr("plenger.adapters.scanners.planning.version_probe", lambda name: "0.1.0")
    plan = plan_scanner(
        "trivy",
        tmp_path,
        expected_version="0.1",
        expected_binary_hash=binary_hash,
        executable=binary,
    )
    fixture = tmp_path / "scanner-fixture.sh"
    fixture.write_text(f"#!/bin/sh\n{script}\n")
    monkeypatch.setattr(
        "plenger.adapters.scanners.execution._execution_argv",
        lambda current, runtime_home: ["/bin/sh", str(fixture)],
    )

    result = execute_scanner(plan)

    assert result.status == "error"
    assert result.reason == expected_reason


def test_scanner_execution_rejects_output_over_limit(monkeypatch, tmp_path):
    binary = tmp_path / "trivy"
    binary.write_bytes(b"managed-trivy")
    binary_hash = hashlib.sha256(binary.read_bytes()).hexdigest()
    monkeypatch.setattr("plenger.adapters.scanners.planning.version_probe", lambda name: "0.1.0")
    monkeypatch.setattr("plenger.adapters.scanners.execution.MAX_OUTPUT_BYTES", 8)
    plan = plan_scanner(
        "trivy",
        tmp_path,
        expected_version="0.1",
        expected_binary_hash=binary_hash,
        executable=binary,
    )
    fixture = tmp_path / "scanner-fixture.sh"
    fixture.write_text("#!/bin/sh\nprintf 123456789\n")
    monkeypatch.setattr(
        "plenger.adapters.scanners.execution._execution_argv",
        lambda current, runtime_home: ["/bin/sh", str(fixture)],
    )

    result = execute_scanner(plan)

    assert result.status == "error"
    assert result.reason == "scanner_output_too_large"


def test_scanner_execution_rejects_timeout(monkeypatch, tmp_path):
    binary = tmp_path / "trivy"
    binary.write_bytes(b"managed-trivy")
    binary_hash = hashlib.sha256(binary.read_bytes()).hexdigest()
    monkeypatch.setattr("plenger.adapters.scanners.planning.version_probe", lambda name: "0.1.0")
    plan = replace(
        plan_scanner(
            "trivy",
            tmp_path,
            expected_version="0.1",
            expected_binary_hash=binary_hash,
            executable=binary,
        ),
        timeout_seconds=1,
    )
    fixture = tmp_path / "scanner-fixture.sh"
    fixture.write_text("#!/bin/sh\nsleep 2\n")
    monkeypatch.setattr(
        "plenger.adapters.scanners.execution._execution_argv",
        lambda current, runtime_home: ["/bin/sh", str(fixture)],
    )

    result = execute_scanner(plan)

    assert result.status == "error"
    assert result.reason == "scanner_timeout"


def test_scanner_normalizer_maps_engine_cwd_relative_path_to_target(tmp_path, monkeypatch):
    target = tmp_path / "project"
    target.mkdir()
    (target / "vulnerable.py").write_text("eval(input())\n")
    monkeypatch.chdir(tmp_path)

    result = normalize_semgrep(
        json.dumps(
            {
                "results": [
                    {
                        "check_id": "python.eval",
                        "path": f"{target.name}/vulnerable.py",
                        "start": {"line": 1},
                        "extra": {"severity": "ERROR"},
                    }
                ]
            }
        ),
        base_dir=target,
    )

    assert result.findings[0].path == "vulnerable.py"
