import json
import subprocess
import uuid

import pytest
from typer.testing import CliRunner

from plenger.adapters.python_parser import IMAGE, docker_env, probe, sandbox_argv
from plenger.cli.main import app
from plenger.services.application import scan
from plenger.services.reports import export_report, latest
from plenger.services.workspace import initialize


def require_sandbox():
    if probe()["status"] != "ready":
        pytest.skip("BLOCKED: pinned Docker image/runtime unavailable; no host fallback")


def test_live_offline_slice(tmp_path):
    require_sandbox()
    marker = "sk-syntheticSECRET0123456789"
    (tmp_path / "fixture.py").write_text(
        f'raise RuntimeError("must not execute")\nsecret = "{marker}"\ndef f(x): return eval(x)'
    )
    initialize(tmp_path)
    report = scan(tmp_path, "deterministic")
    assert report["state"] == "completed"
    assert len(report["findings"]) == 1
    stored = latest(tmp_path, report["run_id"])
    assert stored["run_id"] == report["run_id"]
    assert stored["snapshot_integrity"] == "verified"
    assert stored["findings"][0]["evidence_integrity"] == "verified"
    assert marker not in export_report(report, "json")
    for path in (tmp_path / ".plenger").iterdir():
        assert marker.encode() not in path.read_bytes()
    assert report["findings"][0]["validation_state"] == "candidate"
    assert report["engine_states"]["jev"]["status"] == "unavailable"


def test_baseline_incomplete_and_invalid_cli(tmp_path):
    require_sandbox()
    initialize(tmp_path)
    (tmp_path / "f.py").write_text('eval("1")')
    result = CliRunner().invoke(app, ["scan", "--project", str(tmp_path), "--profile", "baseline"])
    assert result.exit_code == 2, result.output
    report = json.loads(result.output)
    assert report["state"] == "completed_with_errors" and report["findings"]
    result = CliRunner().invoke(app, ["export", report["run_id"], "--project", str(tmp_path)])
    assert result.exit_code == 0


def test_container_network_filesystem_and_credentials(tmp_path):
    require_sandbox()
    # This is trusted test code, never copied from a target repository.
    worker = tmp_path / "probe.py"
    worker.write_text("""import os, socket, json
results = {}
try:
 socket.create_connection(("192.0.2.1", 443), timeout=0.2)
 results["network"] = "UNEXPECTED"
except OSError:
 results["network"] = "blocked"
try:
 open("/write-test", "w").write("x")
 results["write"] = "UNEXPECTED"
except OSError:
 results["write"] = "blocked"
results["uid"] = os.getuid()
results["docker_socket"] = os.path.exists("/var/run/docker.sock")
results["credential"] = os.environ.get("TYPESAFE_API_KEY")
print(json.dumps(results))
""")
    result = subprocess.run(
        sandbox_argv("plenger-test-isolation", worker),
        input=b"",
        capture_output=True,
        env=docker_env(),
        timeout=30,
    )
    assert result.returncode == 0, result.stderr.decode()
    assert json.loads(result.stdout) == {
        "network": "blocked",
        "write": "blocked",
        "uid": 65534,
        "docker_socket": False,
        "credential": None,
    }
    assert "@sha256:" in IMAGE


def test_async_scan_api_and_full_export(tmp_path):
    import time

    from fastapi.testclient import TestClient

    from plenger.api.app import ORIGIN, create_app

    require_sandbox()
    initialize(tmp_path)
    (tmp_path / "fixture.py").write_text("def f(x): return eval(x)")
    application = create_app(tmp_path)
    with TestClient(application, base_url=ORIGIN) as client:
        session = client.post(
            "/api/v1/pair",
            json={"code": application.state.pairing.code},
            headers={"Origin": ORIGIN},
        ).json()
        headers = {
            "Origin": ORIGIN,
            "X-CSRF-Token": session["csrf_token"],
            "Idempotency-Key": "fixture",
        }
        path = f"/api/v1/projects/{session['project_id']}/scans"
        response = client.post(
            path, json={"profile": "deterministic", "fixture": True}, headers=headers
        )
        assert response.status_code == 202
        run_id = response.json()["run_id"]
        repeat = client.post(
            path, json={"profile": "deterministic", "fixture": True}, headers=headers
        )
        assert repeat.json()["run_id"] == run_id
        assert client.post(path, json={"profile": "baseline"}, headers=headers).status_code == 409
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            status = client.get(f"/api/v1/runs/{run_id}").json()
            if status["state"] not in {"queued", "running"}:
                break
            time.sleep(0.05)
        assert status["state"] == "completed", status
        report = client.get(f"/api/v1/runs/{run_id}/exports/json").json()
        assert report["fixture"] and report["snapshot"]["files"]
        assert report["coverage"] == [
            {"category": f"LLM{index:02d}", "state": "not_tested"} for index in range(1, 11)
        ]
        assert {"commit", "dirty"}.issubset(report["snapshot"])
        finding = report["findings"][0]
        response = client.get(f"/api/v1/findings/{finding['id']}?run_id={run_id}")
        assert response.json()["evidence"]["run_id"] == run_id


def test_labeled_grammar_through_real_sandbox():
    from pathlib import Path

    from plenger.adapters.python_parser import execute

    require_sandbox()
    fixture_root = Path(__file__).parents[2] / "fixtures/grammar"
    corpora = [
        json.loads((fixture_root / name).read_text())
        for name in ("python-fastapi-v1.json", "python-fastapi-holdout-v1.json")
    ]
    cases = [case for corpus in corpora for case in corpus["cases"]]
    files = {case["id"] + ".py": case["source"] for case in cases}
    assert len(files) == len(cases), "grammar corpus case IDs must be unique"
    result = execute(files, "corpus-integration")
    assert len(result["findings"]) == sum(case["findings"] for case in cases)
    assert len(result["errors"]) == sum(case["errors"] for case in cases)
    for case in cases:
        nodes = [
            node for node in result["nodes"] if node["source_ref"]["path"] == case["id"] + ".py"
        ]
        assert sorted(node["label"] for node in nodes if node["kind"] == "symbol") == sorted(
            case["symbols"]
        )
        assert sorted(node["label"] for node in nodes if node["kind"] == "endpoint") == sorted(
            label for _, label in case["endpoints"]
        )


def test_real_orphan_container_is_removed_without_replay(tmp_path):
    import uuid

    from sqlalchemy import text

    from plenger.adapters.python_parser import cleanup_run, docker_command
    from plenger.domain.runs import RunState
    from plenger.services.application import project_id, queue_scan, recover_runs, run_status
    from plenger.storage.database import open_store
    from plenger.storage.runs import advance

    require_sandbox()
    initialize(tmp_path)
    run_id, _ = queue_scan(tmp_path, "deterministic", False, "orphan-test")
    engine = open_store(tmp_path)
    with engine.begin() as connection:
        advance(connection, project_id(tmp_path), run_id, RunState.RUNNING)
    engine.dispose()
    # Trusted test fixture simulates a worker outliving its host process.
    worker = tmp_path / "sleep_fixture.py"
    worker.write_text("import time\ntime.sleep(60)\n")
    name = "plenger-" + uuid.UUID(run_id).hex
    argv = sandbox_argv(name, worker)
    argv.insert(argv.index("run") + 1, "--detach")
    try:
        started = subprocess.run(argv, input=b"", capture_output=True, env=docker_env(), timeout=10)
        assert started.returncode == 0, started.stderr.decode()
        assert recover_runs(tmp_path) == 1
        assert run_status(tmp_path, run_id)["state"] == "interrupted"
        inspected = subprocess.run(
            [*docker_command(), "container", "inspect", name],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=docker_env(),
            timeout=5,
        )
        assert inspected.returncode != 0
        engine = open_store(tmp_path)
        with engine.connect() as connection:
            assert connection.execute(text("SELECT COUNT(*) FROM reports")).scalar() == 0
        engine.dispose()
    finally:
        cleanup_run(run_id)


def test_real_parser_merges_bounded_batches(monkeypatch):
    from plenger.adapters import python_parser as adapters

    require_sandbox()
    monkeypatch.setattr(adapters, "BATCH_MAX_FILES", 1)
    files = {
        "a.py": "def a(value):\n    return eval(value)\n",
        "b.py": "x = " + "+".join(["1"] * 5000) + "\n",
        "c.py": "def c():\n    return 1\n",
    }
    assert len(adapters.parser_batches(files)) == 3

    result = adapters.execute(files, "p" * 64, str(uuid.uuid4()))

    assert {node["label"] for node in result["nodes"] if node["kind"] == "file"} == set(files)
    assert [finding["source_ref"]["path"] for finding in result["findings"]] == ["a.py"]
    assert result["errors"] == [{"path": "b.py", "reason": "analysis_depth_limit"}]
