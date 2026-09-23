import hashlib
import json
import platform
import shlex
import shutil
import socket
from pathlib import Path

import pytest

from plenger.adapters.scanners import (
    SCANNER_CONTAINER_IMAGES,
    container_image_present,
    container_runtime_mode,
    execute_scanner,
    plan_scanner,
)
from plenger.services.application import scan
from plenger.services.scanners import (
    provision_scanners,
    run_managed_scanners,
    scanner_findings_to_report,
)
from plenger.services.workspace import initialize


@pytest.mark.skipif(platform.system() != "Darwin", reason="Seatbelt is macOS-specific")
def test_darwin_scanner_cannot_read_outside_staging(tmp_path, monkeypatch):
    initialize(tmp_path)
    binary = tmp_path / "bin" / "trivy"
    binary.parent.mkdir()
    outside = tmp_path / "outside-secret.txt"
    outside.write_text("synthetic outside secret\n")
    outside_payload = (
        '{"Results":[{"Target":"probe.txt","Secrets":['
        '{"RuleID":"outside-read","Severity":"HIGH","StartLine":1}]}]}'
    )
    binary.write_text(
        "#!/bin/sh\n"
        'if [ "$1" = "--version" ]; then printf \'0.1.0\\n\'; exit 0; fi\n'
        f'if /bin/cat "{outside}" >/dev/null 2>&1; then\n'
        f"  printf '%s' '{outside_payload}'\n"
        "else\n"
        "  printf '%s' '{\"Results\":[]}'\n"
        "fi\n"
    )
    binary.chmod(0o700)
    monkeypatch.setattr(
        "plenger.services.scanners.shutil.which",
        lambda name: "/usr/bin/sandbox-exec" if name == "sandbox-exec" else str(binary),
    )
    provision_scanners(tmp_path, ["trivy"])

    results, states = run_managed_scanners(tmp_path, {"probe.txt": "safe\n"})

    assert states["trivy"]["status"] == "completed"
    assert results[0].findings == []


@pytest.mark.skipif(
    platform.system() != "Darwin"
    or shutil.which("sandbox-exec") is None
    or not Path("/usr/bin/curl").is_file(),
    reason="Seatbelt network denial requires the macOS sandbox and system curl",
)
def test_darwin_scanner_runtime_cannot_connect_to_loopback(tmp_path):
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    binary = tmp_path / "bin" / "trivy"
    binary.parent.mkdir()
    outcome = runtime / "network-probe"

    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        port = listener.getsockname()[1]
        binary.write_text(
            "#!/bin/sh\n"
            'if [ "$1" = "--version" ]; then printf \'0.1.0\\n\'; exit 0; fi\n'
            f"/usr/bin/curl --disable --noproxy '*' --max-time 2 --silent --show-error "
            f"{shlex.quote(f'http://127.0.0.1:{port}/')} >/dev/null 2>&1\n"
            "status=$?\nprintf '%s' \"$status\" > "
            f"{shlex.quote(str(outcome))}\n"
            "printf '{\"Results\":[]}\\n'\n"
        )
        binary.chmod(0o700)
        plan = plan_scanner(
            "trivy",
            tmp_path,
            expected_version="0.1.0",
            expected_binary_hash=hashlib.sha256(binary.read_bytes()).hexdigest(),
            executable=binary,
            runtime_home=runtime,
            timeout_seconds=10,
        )

        result = execute_scanner(plan)
        assert result.status == "completed", result.reason
        assert result.findings == []
        listener.setblocking(False)
        with pytest.raises(BlockingIOError):
            listener.accept()

    assert outcome.read_text() == "7"


@pytest.mark.skipif(shutil.which("semgrep") is None, reason="BLOCKED: Semgrep is not installed")
def test_managed_semgrep_finds_positive_and_ignores_fixed_fixture(tmp_path):
    initialize(tmp_path)
    provision_scanners(tmp_path, ["semgrep"])

    results, states = run_managed_scanners(
        tmp_path,
        {
            "vulnerable.py": "value = eval(input())\n",
            "fixed.py": "from ast import literal_eval\nvalue = literal_eval(input())\n",
        },
    )

    assert states["semgrep"]["status"] == "completed"
    assert len(results) == 1
    assert results[0].engine == "semgrep"
    assert {finding.path for finding in results[0].findings} == {"vulnerable.py"}


@pytest.mark.skipif(
    container_runtime_mode() != "docker_pinned"
    or not container_image_present(SCANNER_CONTAINER_IMAGES["semgrep"]),
    reason="BLOCKED: pinned Docker scanner image is unavailable",
)
def test_managed_semgrep_container_worker_uses_managed_rules(tmp_path):
    initialize(tmp_path)
    provisioning = provision_scanners(tmp_path, ["semgrep"], container=True)
    assert provisioning["engines"]["semgrep"]["status"] == "ready"

    results, states = run_managed_scanners(
        tmp_path,
        {
            "vulnerable.py": "value = eval(input())\n",
            "fixed.py": "from ast import literal_eval\nvalue = literal_eval(input())\n",
        },
    )

    assert states["semgrep"]["status"] == "completed"
    assert states["semgrep"]["isolation"] == "docker_pinned"
    assert len(results) == 1
    assert {finding.path for finding in results[0].findings} == {"vulnerable.py"}


@pytest.mark.skipif(shutil.which("trivy") is None, reason="BLOCKED: Trivy is not installed")
def test_managed_trivy_redacts_positive_secret_and_keeps_negative_control(tmp_path):
    initialize(tmp_path)
    provision_scanners(tmp_path, ["trivy"])
    synthetic_key = "AKIA" + "A" * 16

    results, states = run_managed_scanners(
        tmp_path,
        {
            "positive.txt": f"token = {synthetic_key}\n",
            "negative.txt": "token = deliberately-not-a-provider-key\n",
        },
    )

    assert states["trivy"]["status"] == "completed"
    assert len(results) == 1
    assert {finding.path for finding in results[0].findings} == {"positive.txt"}
    report_findings = scanner_findings_to_report(results)
    assert synthetic_key not in json.dumps(report_findings)


@pytest.mark.skipif(
    container_runtime_mode() != "docker_pinned"
    or not container_image_present(SCANNER_CONTAINER_IMAGES["trivy"]),
    reason="BLOCKED: pinned Docker scanner image is unavailable",
)
def test_managed_trivy_container_worker_isolated_and_redacts_output(tmp_path):
    initialize(tmp_path)
    provisioning = provision_scanners(tmp_path, ["trivy"], container=True)
    assert provisioning["engines"]["trivy"]["status"] == "ready"

    synthetic_key = "AKIA" + "B" * 16
    results, states = run_managed_scanners(
        tmp_path,
        {"positive.txt": f"token = {synthetic_key}\n", "negative.txt": "safe\n"},
    )

    assert states["trivy"]["status"] == "completed"
    assert states["trivy"]["isolation"] == "docker_pinned"
    assert len(results) == 1
    assert {finding.path for finding in results[0].findings} == {"positive.txt"}
    assert synthetic_key not in json.dumps(scanner_findings_to_report(results))


@pytest.mark.skipif(
    shutil.which("semgrep") is None or shutil.which("trivy") is None,
    reason="BLOCKED: Semgrep and Trivy are not installed",
)
def test_baseline_persists_real_managed_scanner_findings_without_clean_fallback(
    tmp_path, monkeypatch
):
    initialize(tmp_path)
    provision_scanners(tmp_path, ["semgrep", "trivy"])
    (tmp_path / "vulnerable.py").write_text("value = eval(input())\n")
    synthetic_key = "AKIA" + "A" * 16
    (tmp_path / "positive.txt").write_text(f"token = {synthetic_key}\n")

    monkeypatch.setattr(
        "plenger.services.application.probe",
        lambda: {"status": "ready", "reason": "test_sandbox"},
    )
    monkeypatch.setattr(
        "plenger.services.application.execute",
        lambda files, project, run_id: {
            "nodes": [],
            "edges": [],
            "findings": [],
            "errors": [],
            "limitations": [],
        },
    )

    report = scan(tmp_path, "baseline")

    assert report["state"] == "completed_with_errors"
    assert report["scanner_errors"]
    assert {item["source_ref"]["path"] for item in report["findings"]} == {
        "positive.txt",
        "vulnerable.py",
    }
    assert report["engine_states"]["semgrep"]["status"] == "completed"
    assert report["engine_states"]["trivy"]["status"] == "completed"
    assert report["engine_states"]["osv"]["status"] == "unavailable"
    for artifact in (tmp_path / ".plenger").rglob("*"):
        if artifact.is_file():
            assert synthetic_key.encode() not in artifact.read_bytes()
