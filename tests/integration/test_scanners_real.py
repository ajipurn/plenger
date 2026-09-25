import hashlib
import json
import platform
import shlex
import shutil
import socket
from pathlib import Path

import pytest

from plenger.adapters.scanners.containers import (
    SCANNER_CONTAINER_IMAGES,
    container_image_present,
    container_runtime_mode,
)
from plenger.adapters.scanners.execution import execute_scanner
from plenger.adapters.scanners.planning import plan_scanner
from plenger.services.application import scan
from plenger.services.scanners.baseline import run_managed_scanners, scanner_findings_to_report
from plenger.services.scanners.provisioning import provision_scanners
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
        "plenger.services.scanners.provisioning.shutil.which",
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


@pytest.mark.skipif(shutil.which("trivy") is None, reason="BLOCKED: Trivy is not installed")
def test_trivy_secret_never_reaches_storage_api_exports_or_hosted_request(
    tmp_path, monkeypatch, caplog, capsys
):
    import tempfile

    import httpx
    from fastapi.testclient import TestClient

    from plenger.api.app import ORIGIN, create_app
    from plenger.evaluators import providers as evaluators
    from plenger.services import application
    from plenger.services import assessment as assessment_service
    from plenger.services.assessment import (
        JEV_CONSENT_DATA_CLASSES,
        evaluate_finding,
        grant_hosted_consent_for_project,
    )

    initialize(tmp_path)
    scanner_temporaries = tmp_path / "scanner-temporaries"
    scanner_temporaries.mkdir(mode=0o700)
    monkeypatch.setattr(tempfile, "tempdir", str(scanner_temporaries))
    provision_scanners(tmp_path, ["trivy"])
    synthetic_key = "AKIA" + "C" * 16
    fixtures = {
        "settings.yaml": f"aws_access_key_id: {synthetic_key}\n",
        "credentials.toml": f'aws_access_key_id = "{synthetic_key}"\n',
        "src/settings.py": f'aws_access_key_id = "{synthetic_key}"\n',
        "positive.txt": f"token = {synthetic_key}\n",
        "negative.txt": "token = deliberately-not-a-provider-key\n",
    }
    for relative, content in fixtures.items():
        path = tmp_path / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)

    monkeypatch.setattr(application, "probe", lambda: {"status": "ready"})
    monkeypatch.setattr(
        application,
        "execute",
        lambda files, project, run_id: {
            "nodes": [],
            "edges": [],
            "findings": [],
            "errors": [],
            "limitations": [],
        },
    )
    report = application.scan(tmp_path, "baseline")
    secret_locations = {
        item["source_ref"]["path"]: item["source_ref"]["line"]
        for item in report["findings"]
        if item["kind"] == "secret"
    }
    assert secret_locations == {
        "credentials.toml": 1,
        "positive.txt": 1,
        "settings.yaml": 1,
        "src/settings.py": 1,
    }
    assert synthetic_key not in json.dumps(report)
    assert list(scanner_temporaries.iterdir()) == []

    with TestClient(create_app(tmp_path), base_url=ORIGIN) as client:
        paired = client.post(
            "/api/v1/pair",
            json={"code": client.app.state.pairing.code},
            headers={"Origin": ORIGIN},
        )
        assert paired.status_code == 200
        report_response = client.get(
            f"/api/v1/projects/{report['project_id']}/report?run_id={report['run_id']}"
        )
        assert report_response.status_code == 200
        assert synthetic_key not in report_response.text
        json_export = client.get(f"/api/v1/runs/{report['run_id']}/exports/json")
        html_export = client.get(f"/api/v1/runs/{report['run_id']}/exports/html")
        assert json_export.status_code == html_export.status_code == 200
        assert synthetic_key not in json_export.text
        assert synthetic_key not in html_export.text

    grant_hosted_consent_for_project(
        tmp_path,
        "jev",
        JEV_CONSENT_DATA_CLASSES,
    )
    request_capture: dict[str, object] = {}
    provider_response = {
        "model": evaluators.JEV_DEFAULT_MODEL,
        "answers": {
            "evidence_sufficiency": {
                "type": "choice",
                "choice": "sufficient",
                "probabilities": {"sufficient": 1.0, "insufficient": 0.0, "contradictory": 0.0},
                "confidence": 0.99,
            },
            "policy_violation": {"type": "noul", "noul": 0.0},
        },
        "usage": {"input_tokens": 32, "output_tokens": 5},
    }

    def handler(request: httpx.Request) -> httpx.Response:
        request_capture["body"] = json.loads(request.content)
        return httpx.Response(200, json=provider_response)

    provider_client = httpx.Client(transport=httpx.MockTransport(handler))
    monkeypatch.setenv("TYPESAFE_API_KEY", "synthetic-jev-key")
    original_provider = assessment_service.JevProvider
    monkeypatch.setattr(
        assessment_service,
        "JevProvider",
        lambda api_key: original_provider(api_key, client=provider_client),
    )
    finding_id = next(item["id"] for item in report["findings"] if item["kind"] == "secret")
    try:
        assessment = evaluate_finding(
            tmp_path,
            report["run_id"],
            finding_id,
            "jev",
            True,
            data_classes=JEV_CONSENT_DATA_CLASSES,
        )
    finally:
        provider_client.close()
    assert assessment["state"] == "evaluated"
    assert synthetic_key not in json.dumps(request_capture["body"])

    storage = tmp_path / ".plenger"
    for artifact in storage.rglob("*"):
        if artifact.is_file():
            assert synthetic_key.encode() not in artifact.read_bytes()
    assert synthetic_key not in caplog.text
    captured = capsys.readouterr()
    assert synthetic_key not in captured.out + captured.err


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
