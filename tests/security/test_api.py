import json
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from plenger.api import ORIGIN, Sessions, create_app
from plenger.runner import FixtureObserver
from plenger.services.application import queue_scan
from plenger.services.workspace import initialize
from plenger.storage.backup import create_database_backup
from plenger.storage.database import open_store, save_report
from plenger.storage.locking import StoreBusy


@pytest.fixture
def client(tmp_path):
    initialize(tmp_path)
    return TestClient(create_app(tmp_path), base_url=ORIGIN)


def pair(client):
    response = client.post(
        "/api/v1/pair", json={"code": client.app.state.pairing.code}, headers={"Origin": ORIGIN}
    )
    assert response.status_code == 200
    return response.json()


def test_api_lifespan_holds_server_lock_against_backup(tmp_path):
    initialize(tmp_path)
    with TestClient(create_app(tmp_path), base_url=ORIGIN) as client:
        assert client.get("/api/v1/health").status_code == 200
        with pytest.raises(StoreBusy, match="project_worker_busy"):
            create_database_backup(tmp_path)

    assert create_database_backup(tmp_path)["status"] == "ready"


def test_pairing_session_and_project_boundary(client):
    assert client.get("/api/v1/capabilities").status_code == 401
    session = pair(client)
    cookies = client.cookies
    assert cookies.get("plenger_session")
    assert client.get("/api/v1/session").json()["project_id"] == session["project_id"]
    assert client.get("/api/v1/projects/wrong/report").status_code == 404
    assert client.get(f"/api/v1/projects/{session['project_id']}/report").json() == {"report": None}
    assert (
        client.post(
            "/api/v1/pair", json={"code": client.app.state.pairing.code}, headers={"Origin": ORIGIN}
        ).status_code
        == 401
    )


def test_foreign_project_finding_and_evidence_ids_are_not_retrievable(client):
    root = client.app.state.project_root
    foreign_run = str(uuid.uuid4())
    foreign_project = "foreign-project-identity"
    foreign_finding = "a" * 64
    foreign_evidence = "b" * 64
    engine = open_store(root)
    try:
        save_report(
            engine,
            {
                "run_id": foreign_run,
                "project_id": foreign_project,
                "profile": "deterministic",
                "state": "completed",
                "errors": [],
                "limitations": [],
                "findings": [
                    {
                        "id": foreign_finding,
                        "evidence": {
                            "id": foreign_evidence,
                            "source": "foreign-fixture",
                            "observed": "foreign project evidence marker",
                            "redaction_version": "metadata-only-v1",
                        },
                    }
                ],
            },
        )
    finally:
        engine.dispose()

    session = pair(client)
    project_id = session["project_id"]
    assert client.get(f"/api/v1/projects/{project_id}/report").json() == {"report": None}
    assert (
        client.get(f"/api/v1/projects/{project_id}/report?run_id={foreign_run}").status_code == 404
    )
    foreign_detail = client.get(f"/api/v1/findings/{foreign_finding}?run_id={foreign_run}")
    assert foreign_detail.status_code == 404
    assert foreign_evidence not in foreign_detail.text


def test_corrupt_assessment_payload_uses_safe_storage_error(client, monkeypatch):
    session = pair(client)
    monkeypatch.setattr(
        "plenger.api.assessments_page_for_run",
        lambda *args, **kwargs: (_ for _ in ()).throw(ValueError("invalid_assessment_payload")),
    )
    run_id, _ = queue_scan(client.app.state.project_root, "deterministic", False, "bad-assessment")

    response = client.get(f"/api/v1/runs/{run_id}/assessments")

    assert response.status_code == 503
    assert response.json()["code"] == "assessment_unavailable"
    assert session["project_id"]


@pytest.mark.parametrize(
    "headers",
    [{"Host": "evil.example"}, {"Origin": "https://evil.example"}, {"Host": "localhost:7331"}],
)
def test_hostile_host_or_origin(client, headers):
    response = client.get("/api/v1/health", headers=headers)
    assert response.status_code == 403
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["referrer-policy"] == "no-referrer"
    assert "frame-ancestors 'none'" in response.headers["content-security-policy"]


def test_unexpected_api_error_uses_safe_envelope(client, monkeypatch):
    session = pair(client)
    monkeypatch.setattr(
        "plenger.api.capabilities",
        lambda root: (_ for _ in ()).throw(RuntimeError("sensitive-provider-detail")),
    )

    safe_client = TestClient(client.app, base_url=ORIGIN, raise_server_exceptions=False)
    safe_client.cookies.update(client.cookies)
    response = safe_client.get("/api/v1/capabilities")
    safe_client.close()
    assert response.status_code == 500
    assert response.json()["code"] == "internal_error"
    assert "sensitive-provider-detail" not in response.text
    assert response.json()["request_id"]
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert session["project_id"]


def test_asset_route_only_serves_packaged_single_files(client):
    asset = next((Path(__file__).resolve().parents[2] / "src/plenger/ui/assets").glob("*.js")).name
    served = client.get(f"/assets/{asset}")
    assert served.status_code == 200
    assert served.headers["x-content-type-options"] == "nosniff"
    assert client.get("/assets/not-a-real-asset.js").status_code == 404
    assert client.get("/assets/%2e%2e").status_code == 404


def test_csrf_and_logout(client):
    session = pair(client)
    assert client.post("/api/v1/logout").status_code == 403
    assert client.post("/api/v1/logout", headers={"Origin": ORIGIN}).status_code == 403
    assert (
        client.post(
            "/api/v1/logout", headers={"Origin": ORIGIN, "X-CSRF-Token": session["csrf_token"]}
        ).status_code
        == 200
    )
    assert client.get("/api/v1/session").status_code == 401


def test_pair_expiry_rate_limit_and_one_use_atomicity():
    expired = Sessions()
    expired.deadline = time.monotonic() - 1
    assert expired.pair(expired.code) is None
    limited = Sessions()
    for _ in range(5):
        assert limited.pair("wrong") is None
    assert limited.pair(limited.code) is None
    sessions = Sessions()
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(sessions.pair, [sessions.code] * 8))
    assert sum(result is not None for result in results) == 1


def test_expired_session(client):
    pair(client)
    token = client.cookies.get("plenger_session")
    client.app.state.pairing.sessions[token] = (0, "expired")
    assert client.get("/api/v1/session").status_code == 401


def test_body_limit_and_no_sensitive_validation_echo(client):
    marker = "sk-secret-MARKER0123456789"
    response = client.post("/api/v1/pair", json={"secret": marker}, headers={"Origin": ORIGIN})
    assert response.status_code == 422
    assert marker not in response.text
    response = client.post("/api/v1/pair", content=b"x" * 1025, headers={"Origin": ORIGIN})
    assert response.status_code == 413


def test_cookie_flags_and_security_headers(client):
    response = client.post(
        "/api/v1/pair", json={"code": client.app.state.pairing.code}, headers={"Origin": ORIGIN}
    )
    cookie = response.headers["set-cookie"]
    assert "HttpOnly" in cookie and "SameSite=strict" in cookie and "Domain=" not in cookie
    assert "frame-ancestors 'none'" in response.headers["content-security-policy"]
    assert response.headers["cache-control"] == "no-store"


def test_scan_requires_csrf_and_idempotency(client):
    session = pair(client)
    url = f"/api/v1/projects/{session['project_id']}/scans"
    assert client.post(url, json={}, headers={"Origin": ORIGIN}).status_code == 403
    assert (
        client.post(
            url, json={}, headers={"Origin": ORIGIN, "X-CSRF-Token": session["csrf_token"]}
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/api/v1/projects/foreign/scans",
            json={},
            headers={
                "Origin": ORIGIN,
                "X-CSRF-Token": session["csrf_token"],
                "Idempotency-Key": "one",
            },
        ).status_code
        == 404
    )
    assert client.get("/api/v1/runs/foreign").status_code == 404
    assert client.get("/api/v1/runs/foreign/exports/json").status_code == 404
    assert client.get("/api/v1/findings/foreign?run_id=foreign").status_code == 404


def test_graph_pagination_rejects_oversize(client):
    session = pair(client)
    path = f"/api/v1/projects/{session['project_id']}/graph"
    assert client.get(path + "?limit=101").status_code == 422
    assert client.get(path + "?offset=-1").status_code == 422
    assert client.get(path).json()["nodes"] == []


def test_hosted_assessment_consent_preview_and_grant_are_scoped(client):
    session = pair(client)
    preview_path = "/api/v1/assessment-consent"
    preview = client.get(preview_path)
    assert preview.status_code == 200
    assert preview.json()["granted"] is False
    assert preview.json()["domain"] == "api.typesafe.ai"
    headers = {"Origin": ORIGIN, "X-CSRF-Token": session["csrf_token"]}
    assert (
        client.post(
            preview_path,
            json={
                "provider": "jev",
                "data_classes": ["response"],
                "acknowledgment": "I_AUTHORIZE_HOSTED_ASSESSMENT",
            },
            headers=headers,
        ).status_code
        == 422
    )
    granted = client.post(
        preview_path,
        json={
            "provider": "jev",
            "data_classes": ["metadata", "code_excerpt", "response"],
            "acknowledgment": "I_AUTHORIZE_HOSTED_ASSESSMENT",
        },
        headers=headers,
    )
    assert granted.status_code == 201
    assert client.get(preview_path).json()["granted"] is True
    revoked = client.delete(preview_path, headers=headers)
    assert revoked.status_code == 200
    assert client.get(preview_path).json()["granted"] is False


def test_run_history_and_selected_report_are_project_bound(client):
    from plenger.services.application import project_id, queue_scan
    from plenger.storage.database import open_store, save_report

    session = pair(client)
    root = client.app.state.project_root
    older, _ = queue_scan(root, "deterministic", False, "history-older")
    newer, _ = queue_scan(root, "deterministic", False, "history-newer")
    engine = open_store(root)
    try:
        for run_id in (older, newer):
            findings = (
                [
                    {
                        "id": "a" * 64,
                        "fingerprint": "b" * 64,
                        "lifecycle_state": "resolved",
                    }
                ]
                if run_id == older
                else [
                    {
                        "id": "c" * 64,
                        "fingerprint": "b" * 64,
                        "lifecycle_state": "open",
                    }
                ]
            )
            save_report(
                engine,
                {
                    "run_id": run_id,
                    "project_id": project_id(root),
                    "profile": "deterministic",
                    "state": "completed",
                    "errors": [],
                    "manifest": {"parser": "python-ast-v2"},
                    "nodes": [],
                    "edges": [],
                    "findings": findings,
                },
            )
    finally:
        engine.dispose()
    history = client.get(f"/api/v1/projects/{session['project_id']}/runs")
    assert history.status_code == 200
    assert [item["id"] for item in history.json()["items"]] == [newer, older]
    first_history_page = client.get(f"/api/v1/projects/{session['project_id']}/runs?limit=1")
    assert first_history_page.status_code == 200
    assert [item["id"] for item in first_history_page.json()["items"]] == [newer]
    assert first_history_page.json()["next_offset"] == 1
    second_history_page = client.get(
        f"/api/v1/projects/{session['project_id']}/runs?limit=1&offset=1"
    )
    assert second_history_page.status_code == 200
    assert [item["id"] for item in second_history_page.json()["items"]] == [older]
    assert "next_offset" not in second_history_page.json()
    assert client.get(f"/api/v1/projects/{session['project_id']}/runs?limit=101").status_code == 422
    selected = client.get(f"/api/v1/projects/{session['project_id']}/report?run_id={older}")
    assert selected.status_code == 200
    assert selected.json()["report"]["run_id"] == older
    empty_selected = client.get(f"/api/v1/projects/{session['project_id']}/report?run_id=")
    assert empty_selected.status_code == 200
    assert empty_selected.json() == {"report": None}
    assert (
        client.get(f"/api/v1/projects/{session['project_id']}/report?run_id=foreign").status_code
        == 404
    )
    comparison = client.get(
        f"/api/v1/projects/{session['project_id']}/diff?base_run_id={older}&current_run_id={newer}"
    )
    assert comparison.status_code == 200
    assert comparison.json()["items"][0]["status"] == "reopened"
    assert client.get("/api/v1/projects/foreign/runs").status_code == 404


def test_findings_pagination_reads_normalized_rows_not_report_mirror(client, monkeypatch):
    from plenger.services import application
    from plenger.services.application import queue_scan

    monkeypatch.setattr(application, "probe", lambda: {"status": "ready"})
    monkeypatch.setattr(
        application,
        "execute",
        lambda files, identity, run_id: {
            "nodes": [],
            "edges": [],
            "findings": [
                {
                    "id": f"{index:064x}",
                    "fingerprint": f"{index + 10:064x}",
                    "rule_id": "WK-PY-001",
                    "kind": "code" if index == 1 else "dependency",
                    "severity": "high" if index == 1 else "medium",
                    "severity_source": "plenger-rule",
                    "validation_state": "candidate" if index == 1 else "supported",
                    "lifecycle_state": "open" if index == 1 else "resolved",
                    "assessment_state": "needs_review",
                    "title": f"Finding {index}",
                    "source_ref": {"path": f"file{index}.py", "line": 1},
                    "evidence": {
                        "id": f"{index + 20:064x}",
                        "source": "python-ast-v2",
                        "observed": f"evidence {index}",
                        "redaction_version": "metadata-only-v1",
                    },
                }
                for index in range(1, 3)
            ],
            "errors": [],
            "limitations": [],
        },
    )
    run_id, _ = queue_scan(client.app.state.project_root, "deterministic", False, "api-page")
    application.execute_scan(client.app.state.project_root, run_id)
    session = pair(client)
    monkeypatch.setattr("plenger.api.latest", lambda *args, **kwargs: pytest.fail("report loaded"))
    response = client.get(f"/api/v1/projects/{session['project_id']}/findings?limit=1&offset=1")
    assert response.status_code == 200
    assert [item["title"] for item in response.json()["items"]] == ["Finding 2"]
    assert "project_id" not in response.json()["items"][0]

    first_page = client.get(f"/api/v1/projects/{session['project_id']}/findings?limit=1")
    assert first_page.status_code == 200
    cursor = first_page.json()["next_cursor"]
    assert isinstance(cursor, str) and cursor
    next_page = client.get(
        f"/api/v1/projects/{session['project_id']}/findings?limit=1&cursor={cursor}"
    )
    assert next_page.status_code == 200
    assert [item["title"] for item in next_page.json()["items"]] == ["Finding 2"]
    assert next_page.json()["next_cursor"] is None
    assert (
        client.get(
            f"/api/v1/projects/{session['project_id']}/findings?limit=1&cursor=invalid"
        ).status_code
        == 422
    )
    tampered_cursor = cursor[:-1] + ("A" if cursor[-1] != "A" else "B")
    assert (
        client.get(
            f"/api/v1/projects/{session['project_id']}/findings?limit=1&cursor={tampered_cursor}"
        ).status_code
        == 422
    )
    assert (
        client.get(
            f"/api/v1/projects/{session['project_id']}/findings?limit=1&offset=1&cursor={cursor}"
        ).status_code
        == 422
    )
    assert (
        client.get(f"/api/v1/projects/{session['project_id']}/findings?severity=medium").json()[
            "items"
        ][0]["title"]
        == "Finding 2"
    )
    assert (
        client.get(
            f"/api/v1/projects/{session['project_id']}/findings?validation_state=supported"
        ).json()["items"][0]["title"]
        == "Finding 2"
    )
    assert (
        client.get(
            f"/api/v1/projects/{session['project_id']}/findings?lifecycle_state=resolved"
        ).json()["items"][0]["title"]
        == "Finding 2"
    )
    assert (
        client.get(
            f"/api/v1/projects/{session['project_id']}/findings?kind=dependency&source_path=file2.py"
        ).json()["items"][0]["title"]
        == "Finding 2"
    )
    assert (
        client.get(
            f"/api/v1/projects/{session['project_id']}/findings?severity=not-a-severity"
        ).status_code
        == 422
    )
    assert (
        client.get(f"/api/v1/projects/{session['project_id']}/findings?kind=").json()["code"]
        == "invalid_finding_filter"
    )
    assert (
        client.get(
            f"/api/v1/projects/{session['project_id']}/findings?severity=high&cursor={cursor}"
        ).status_code
        == 422
    )
    selected_run = client.get(
        f"/api/v1/projects/{session['project_id']}/findings?run_id={run_id}&severity=medium"
    )
    assert selected_run.status_code == 200
    assert [item["title"] for item in selected_run.json()["items"]] == ["Finding 2"]
    assert (
        client.get(f"/api/v1/projects/{session['project_id']}/findings?run_id=foreign").status_code
        == 404
    )


def test_assessment_api_persists_history_without_mutating_authority(client, monkeypatch):
    from plenger.services import application

    monkeypatch.setattr(application, "probe", lambda: {"status": "ready"})
    monkeypatch.setattr(
        application,
        "execute",
        lambda files, identity, run_id: {
            "nodes": [],
            "edges": [],
            "findings": [
                {
                    "id": "a" * 64,
                    "fingerprint": "b" * 64,
                    "rule_id": "WK-PY-001",
                    "kind": "dynamic_code_execution",
                    "severity": "high",
                    "severity_source": "plenger-rule",
                    "validation_state": "candidate",
                    "lifecycle_state": "open",
                    "assessment_state": "needs_review",
                    "title": "Review",
                    "source_ref": {"path": "fixture.py", "line": 1},
                    "evidence": {
                        "id": "c" * 64,
                        "source": "python-ast-v2",
                        "observed": "synthetic observed text",
                        "redaction_version": "metadata-only-v1",
                    },
                }
            ],
            "errors": [],
            "limitations": [],
        },
    )
    run_id, _ = queue_scan(client.app.state.project_root, "deterministic", False, "api-assessment")
    application.execute_scan(client.app.state.project_root, run_id)
    session = pair(client)
    report_path = f"/api/v1/projects/{session['project_id']}/report?run_id={run_id}"
    before = client.get(report_path).json()["report"]
    finding_id = before["findings"][0]["id"]
    authority_before = {
        key: before["findings"][0][key]
        for key in ("severity", "validation_state", "lifecycle_state", "assessment_state")
    }
    from plenger.storage.database import open_store

    engine = open_store(client.app.state.project_root)
    try:
        with engine.begin() as connection:
            payload = json.loads(
                connection.execute(
                    text("SELECT payload FROM reports WHERE id=:run"), {"run": run_id}
                ).scalar_one()
            )
            payload["secretKey"] = "plain-synthetic-assessment-secret"
            connection.execute(
                text("UPDATE reports SET payload=:payload WHERE id=:run"),
                {"payload": json.dumps(payload), "run": run_id},
            )
    finally:
        engine.dispose()
    headers = {"Origin": ORIGIN, "X-CSRF-Token": session["csrf_token"]}

    created = client.post(
        f"/api/v1/runs/{run_id}/assessments",
        json={"finding_id": finding_id, "provider": "deterministic", "consent": False},
        headers=headers,
    )
    assert created.status_code == 201
    assert created.json()["finding_id"] == finding_id
    assert created.json()["state"] == "needs_review"
    assert created.json()["cached"] is False

    history = client.get(f"/api/v1/runs/{run_id}/assessments?finding_id={finding_id}")
    assert history.status_code == 200
    assert len(history.json()["items"]) == 1
    assert history.json()["items"][0]["finding_id"] == finding_id
    assert client.get(f"/api/v1/runs/{run_id}/assessments?finding_id=").json() == {"items": []}
    second = client.post(
        f"/api/v1/runs/{run_id}/assessments",
        json={"finding_id": finding_id, "provider": "deterministic", "consent": False},
        headers=headers,
    )
    assert second.status_code == 201
    assert second.json()["cached"] is True
    assert second.json()["cache_source_id"] == created.json()["id"]
    first_page = client.get(f"/api/v1/runs/{run_id}/assessments?finding_id={finding_id}&limit=1")
    assert first_page.status_code == 200
    assert len(first_page.json()["items"]) == 1
    assert first_page.json()["next_offset"] == 1
    second_page = client.get(
        f"/api/v1/runs/{run_id}/assessments?finding_id={finding_id}&limit=1&offset=1"
    )
    assert second_page.status_code == 200
    assert len(second_page.json()["items"]) == 1
    assert "next_offset" not in second_page.json()
    assert client.get(f"/api/v1/runs/{run_id}/assessments?limit=101").status_code == 422
    assert client.get(f"/api/v1/runs/{run_id}/assessments?offset=-1").status_code == 422

    after = client.get(report_path).json()["report"]
    assert {
        key: after["findings"][0][key]
        for key in ("severity", "validation_state", "lifecycle_state", "assessment_state")
    } == authority_before
    engine = open_store(client.app.state.project_root)
    try:
        with engine.connect() as connection:
            persisted = connection.execute(
                text("SELECT payload FROM reports WHERE id=:run"), {"run": run_id}
            ).scalar_one()
        assert "plain-synthetic-assessment-secret" not in persisted
    finally:
        engine.dispose()


def test_finding_export_and_plan_revoke_routes_enforce_project_and_revision_boundaries(
    client, monkeypatch
):
    from plenger.services import application
    from plenger.services.application import queue_scan

    monkeypatch.setattr(application, "probe", lambda: {"status": "ready"})
    monkeypatch.setattr(
        application,
        "execute",
        lambda files, identity, run_id: {
            "nodes": [],
            "edges": [],
            "findings": [
                {
                    "id": "a" * 64,
                    "fingerprint": "b" * 64,
                    "rule_id": "WK-PY-001",
                    "kind": "code",
                    "severity": "high",
                    "severity_source": "plenger-rule",
                    "validation_state": "candidate",
                    "lifecycle_state": "open",
                    "assessment_state": "needs_review",
                    "title": "Review",
                    "source_ref": {"path": "fixture.py", "line": 1},
                    "evidence": {
                        "id": "c" * 64,
                        "source": "python-ast-v2",
                        "observed": "safe synthetic evidence",
                        "redaction_version": "metadata-only-v1",
                    },
                }
            ],
            "errors": [],
            "limitations": [],
        },
    )
    run_id, _ = queue_scan(client.app.state.project_root, "deterministic", False, "api-boundary")
    report = application.execute_scan(client.app.state.project_root, run_id)
    finding_id = report["findings"][0]["id"]
    session = pair(client)
    headers = {"Origin": ORIGIN, "X-CSRF-Token": session["csrf_token"]}

    detail = client.get(f"/api/v1/findings/{finding_id}?run_id={run_id}")
    assert detail.status_code == 200
    assert detail.json()["id"] == finding_id
    assert client.get(f"/api/v1/findings/{finding_id}?run_id=foreign").status_code == 404
    assert client.get(f"/api/v1/findings/{'f' * 64}?run_id={run_id}").status_code == 404

    updated = client.patch(
        f"/api/v1/findings/{finding_id}",
        json={
            "lifecycle_state": "acknowledged",
            "reason": "triaged by reviewer",
            "expected_revision": 0,
        },
        headers=headers,
    )
    assert updated.status_code == 200
    assert updated.json()["lifecycle_state"] == "acknowledged"
    assert updated.json()["revision"] == 1
    stale = client.patch(
        f"/api/v1/findings/{finding_id}",
        json={
            "lifecycle_state": "resolved",
            "reason": "stale update",
            "expected_revision": 0,
        },
        headers=headers,
    )
    assert stale.status_code == 409
    assert stale.json()["code"] == "finding_revision_conflict_or_not_found"

    exported_json = client.post(
        f"/api/v1/runs/{run_id}/exports",
        json={"format": "json"},
        headers=headers,
    )
    assert exported_json.status_code == 200
    assert exported_json.json()["run_id"] == run_id
    exported_html = client.post(
        f"/api/v1/runs/{run_id}/exports",
        json={"format": "html"},
        headers=headers,
    )
    assert exported_html.status_code == 200
    assert exported_html.headers["content-type"].startswith("text/html")
    assert "<script" not in exported_html.text.lower()
    assert (
        client.post(
            "/api/v1/runs/foreign/exports", json={"format": "json"}, headers=headers
        ).status_code
        == 404
    )
    assert (
        client.post(
            f"/api/v1/runs/{run_id}/exports", json={"format": "xml"}, headers=headers
        ).status_code
        == 422
    )
    static_run, _ = queue_scan(
        client.app.state.project_root, "deterministic", False, "static-cancel-boundary"
    )
    static_cancel = client.post(f"/api/v1/runs/{static_run}/cancel", headers=headers)
    assert static_cancel.status_code == 409
    assert static_cancel.json()["code"] == "cancel_not_supported_for_static_run"

    plan = client.post(
        f"/api/v1/projects/{session['project_id']}/plans",
        json={
            "target": {
                "target_ref": "revoke-fixture",
                "base_url": "http://127.0.0.1:8080",
                "environment": "local",
                "allowed_paths": ["/test"],
                "allowed_methods": ["GET"],
            },
            "case_ids": ["LLM01-direct-policy"],
            "snapshot_digest": "d" * 64,
            "auth_identity": "synthetic-user",
            "budget": {"cost_guard": "request_only", "cost_acknowledged": True},
        },
        headers=headers,
    )
    assert plan.status_code == 201
    plan_id = plan.json()["id"]
    revoked = client.post(f"/api/v1/plans/{plan_id}/revoke", headers=headers)
    assert revoked.status_code == 200
    assert revoked.json() == {"status": "revoked", "plan_id": plan_id}
    assert client.post(f"/api/v1/plans/{plan_id}/revoke", headers=headers).status_code == 409
    assert client.post("/api/v1/plans/foreign/revoke", headers=headers).status_code == 409


def test_report_view_bounds_assessment_mirror_but_history_api_remains_pageable(client, monkeypatch):
    from plenger.evaluators.models import Assessment
    from plenger.services import application
    from plenger.services.application import queue_scan
    from plenger.storage.assessments import save_assessment
    from plenger.storage.database import open_store

    monkeypatch.setattr(application, "probe", lambda: {"status": "ready"})
    monkeypatch.setattr(
        application,
        "execute",
        lambda files, identity, run_id: {
            "nodes": [],
            "edges": [],
            "findings": [
                {
                    "id": "a" * 64,
                    "fingerprint": "b" * 64,
                    "rule_id": "WK-PY-001",
                    "kind": "dynamic_code_execution",
                    "severity": "high",
                    "severity_source": "plenger-rule",
                    "validation_state": "candidate",
                    "lifecycle_state": "open",
                    "assessment_state": "needs_review",
                    "title": "Review",
                    "source_ref": {"path": "fixture.py", "line": 1},
                    "evidence": {
                        "id": "c" * 64,
                        "source": "python-ast-v2",
                        "observed": "synthetic observed text",
                        "redaction_version": "metadata-only-v1",
                    },
                }
            ],
            "errors": [],
            "limitations": [],
        },
    )
    run_id, _ = queue_scan(
        client.app.state.project_root, "deterministic", False, "api-assessment-view"
    )
    application.execute_scan(client.app.state.project_root, run_id)
    root = client.app.state.project_root
    engine = open_store(root)
    try:
        identity = application.project_id(root)
        with engine.begin() as connection:
            row = connection.execute(
                text("SELECT payload FROM reports WHERE id=:run AND project_id=:project"),
                {"run": run_id, "project": identity},
            ).scalar_one()
            report = json.loads(row)
            report["assessments"] = [
                {
                    "id": f"{index:064x}",
                    "finding_id": "a" * 64,
                    "evaluator": "deterministic",
                    "state": "needs_review",
                    "reason_code": "evidence_requires_review",
                    "created_at": f"2026-09-20T00:00:{index:02d}.000000+00:00",
                }
                for index in range(101)
            ]
            report["skipped"] = [
                {"path": f"excluded-{index}.txt", "reason": "excluded"} for index in range(101)
            ]
            report["snapshot"]["files"] = [
                {"path": f"file-{index}.py", "size": 1} for index in range(101)
            ]
            report["snapshot"]["skipped"] = [
                {"path": f"snapshot-excluded-{index}.txt", "reason": "excluded"}
                for index in range(101)
            ]
            connection.execute(
                text("UPDATE reports SET payload=:payload WHERE id=:run AND project_id=:project"),
                {"payload": json.dumps(report), "run": run_id, "project": identity},
            )
            assessment = Assessment(
                evaluator="deterministic",
                state="needs_review",
                reason_code="evidence_requires_review",
                rubric_hash="d" * 64,
                inputs_digest="e" * 64,
            )
            for _ in range(101):
                save_assessment(connection, identity, run_id, "a" * 64, assessment)
    finally:
        engine.dispose()

    session = pair(client)
    report_response = client.get(f"/api/v1/projects/{session['project_id']}/report?run_id={run_id}")
    assert report_response.status_code == 200
    view = report_response.json()["report"]
    assert len(view["assessments"]) == 100
    assert len(view["skipped"]) == 100
    assert len(view["snapshot"]["files"]) == 100
    assert len(view["snapshot"]["skipped"]) == 100
    assert view["counts"]["assessments"] == 101
    assert view["counts"]["skipped"] == 101
    assert view["counts"]["priority_findings"] == 1
    assert view["counts"]["snapshot_files"] == 101
    assert view["counts"]["snapshot_skipped"] == 101
    assert view["view_truncated"] is True

    history = client.get(f"/api/v1/runs/{run_id}/assessments?limit=100")
    assert history.status_code == 200
    assert len(history.json()["items"]) == 100
    assert history.json()["next_offset"] == 100


def test_graph_pagination_reads_normalized_rows_not_report_mirror(client, monkeypatch):
    from plenger.services import application
    from plenger.services.application import queue_scan

    monkeypatch.setattr(application, "probe", lambda: {"status": "ready"})
    monkeypatch.setattr(
        application,
        "execute",
        lambda files, identity, run_id: {
            "nodes": [
                {
                    "id": f"{index:064x}",
                    "kind": "symbol" if index == 1 else "endpoint",
                    "label": f"function_{index}",
                    "source_ref": {"path": f"file{index}.py", "line": index},
                    "provenance": "observed_static",
                    "attributes": {"synthetic": True},
                }
                for index in range(1, 4)
            ],
            "edges": [
                {
                    "id": f"{index + 10:064x}",
                    "source": f"{index:064x}",
                    "target": f"{index + 1:064x}",
                    "kind": "calls",
                    "source_ref": {"path": f"file{index}.py", "line": index},
                    "provenance": "observed_static",
                }
                for index in range(1, 3)
            ],
            "findings": [],
            "errors": [],
            "limitations": [],
        },
    )
    run_id, _ = queue_scan(client.app.state.project_root, "deterministic", False, "api-graph")
    report = application.execute_scan(client.app.state.project_root, run_id)
    from plenger.storage.database import open_store

    engine = open_store(client.app.state.project_root)
    try:
        with engine.begin() as connection:
            connection.execute(
                text(
                    "UPDATE graph_nodes SET attributes=:attributes "
                    "WHERE project_id=:project AND run_id=:run AND node_id=:node"
                ),
                {
                    "attributes": json.dumps(
                        {"secretKey": "plain-synthetic-graph-secret", "synthetic": True}
                    ),
                    "project": report["project_id"],
                    "run": run_id,
                    "node": f"{2:064x}",
                },
            )
    finally:
        engine.dispose()
    session = pair(client)
    monkeypatch.setattr("plenger.api.latest", lambda *args, **kwargs: pytest.fail("report loaded"))
    response = client.get(f"/api/v1/projects/{session['project_id']}/graph?limit=1&offset=1")
    assert response.status_code == 200
    payload = response.json()
    assert payload["snapshot_id"] == report["snapshot_id"]
    assert [item["label"] for item in payload["nodes"]] == ["function_2"]
    assert payload["nodes"][0]["attributes"]["secretKey"] == "[REDACTED]"
    assert [item["kind"] for item in payload["edges"]] == ["calls"]
    assert payload["next_offset"] == 2
    filtered_kind = client.get(f"/api/v1/projects/{session['project_id']}/graph?node_kind=endpoint")
    assert filtered_kind.status_code == 200
    assert [item["label"] for item in filtered_kind.json()["nodes"]] == [
        "function_2",
        "function_3",
    ]
    assert [item["id"] for item in filtered_kind.json()["edges"]] == [f"{12:064x}"]
    filtered_path = client.get(
        f"/api/v1/projects/{session['project_id']}/graph?source_path=file2.py"
    )
    assert filtered_path.status_code == 200
    assert [item["label"] for item in filtered_path.json()["nodes"]] == ["function_2"]
    assert filtered_path.json()["edges"] == []
    assert (
        client.get(f"/api/v1/projects/{session['project_id']}/graph?node_kind=").status_code == 422
    )
    selected = client.get(f"/api/v1/projects/{session['project_id']}/graph?run_id={run_id}&limit=1")
    assert selected.status_code == 200
    assert selected.json()["next_offset"] == 1
    assert (
        client.get(f"/api/v1/projects/{session['project_id']}/graph?run_id=foreign").status_code
        == 404
    )


def test_run_events_are_project_bound_and_resume_by_last_event_id(client):
    session = pair(client)
    run_id, _ = queue_scan(client.app.state.project_root, "deterministic", False, "events")
    response = client.get(f"/api/v1/runs/{run_id}/events")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert "id: 0" in response.text and "queued" in response.text
    assert client.get(f"/api/v1/runs/{run_id}/events", headers={"Last-Event-ID": "0"}).text == ""
    assert client.get(f"/api/v1/runs/{run_id}/events?limit=101").status_code == 422
    assert session["project_id"]


def test_post_export_requires_a_stored_report(client):
    session = pair(client)
    response = client.post(
        "/api/v1/runs/missing/exports",
        json={"format": "json"},
        headers={"Origin": ORIGIN, "X-CSRF-Token": session["csrf_token"]},
    )
    assert response.status_code == 404


def test_attempt_ledger_is_project_bound(client):
    from plenger.services.application import project_id, queue_scan
    from plenger.storage.attempts import record_active_attempt
    from plenger.storage.database import open_store

    session = pair(client)
    run_id, _ = queue_scan(client.app.state.project_root, "deterministic", False, "attempt-api")
    engine = open_store(client.app.state.project_root)
    try:
        with engine.begin() as connection:
            record_active_attempt(
                connection,
                project_id(client.app.state.project_root),
                run_id,
                0,
                {
                    "case_id": "LLM01-direct-policy",
                    "category": "LLM01",
                    "result": "pass",
                    "reason_code": "marker_not_observed",
                    "evidence": ["response_observation"],
                },
            )
    finally:
        engine.dispose()
    assert client.get(f"/api/v1/runs/{run_id}/attempts").json()["items"][0]["case_id"] == (
        "LLM01-direct-policy"
    )
    assert client.get("/api/v1/runs/foreign/attempts").status_code == 404
    assert session["project_id"]


def test_plan_consent_is_project_bound_and_local_runner_is_queued(client):
    session = pair(client)
    headers = {
        "Origin": ORIGIN,
        "X-CSRF-Token": session["csrf_token"],
    }
    path = f"/api/v1/projects/{session['project_id']}/plans"
    payload = {
        "target": {
            "target_ref": "local-fixture",
            "base_url": "http://127.0.0.1:8080",
            "environment": "local",
            "allowed_paths": ["/health"],
            "allowed_methods": ["GET"],
        },
        "case_ids": ["LLM01-direct-policy"],
        "snapshot_digest": "a" * 64,
        "auth_identity": "synthetic-user",
        "budget": {
            "cost_guard": "request_only",
            "cost_acknowledged": True,
        },
    }
    created = client.post(path, json=payload, headers=headers)
    assert created.status_code == 201
    plan = created.json()
    assert plan["preview"]["allowed_ips"] == ["127.0.0.1"]
    assert plan["payload"]["target"]["allowed_ips"] == ["127.0.0.1"]
    stored = client.get(f"/api/v1/plans/{plan['id']}")
    assert stored.status_code == 200
    assert stored.json()["payload"]["target"]["allowed_ips"] == ["127.0.0.1"]
    approval = client.post(
        f"/api/v1/plans/{plan['id']}/approvals",
        json={
            "actor": "local-user",
            "acknowledgment": "I_AUTHORIZE_THIS_EXPLICIT_SCOPE",
            "ttl_minutes": 5,
        },
        headers=headers,
    )
    assert approval.status_code == 201
    active = client.post(
        f"/api/v1/plans/{plan['id']}/runs",
        json={"approval_id": approval.json()["id"]},
        headers={**headers, "Idempotency-Key": "active-test"},
    )
    assert active.status_code == 202
    assert active.json()["run_id"]
    assert client.get(f"/api/v1/plans/{plan['id']}").json()["state"] == "consumed"


def test_active_api_passes_configured_observer_to_background_runner(tmp_path, monkeypatch):
    initialize(tmp_path)
    observer = FixtureObserver()
    application = create_app(tmp_path, active_observer=observer)
    captured: dict[str, object] = {}
    dispatched = threading.Event()

    def capture(root, run_id, *, observer=None):
        captured["root"] = root
        captured["run_id"] = run_id
        captured["observer"] = observer
        dispatched.set()

    monkeypatch.setattr("plenger.api.execute_active_run", capture)
    with TestClient(application, base_url=ORIGIN) as configured_client:
        session = pair(configured_client)
        headers = {
            "Origin": ORIGIN,
            "X-CSRF-Token": session["csrf_token"],
        }
        plan = configured_client.post(
            f"/api/v1/projects/{session['project_id']}/plans",
            json={
                "target": {
                    "target_ref": "observer-fixture",
                    "base_url": "http://127.0.0.1:8080",
                    "environment": "local",
                    "allowed_paths": ["/test"],
                    "allowed_methods": ["POST"],
                    "observability": "trace",
                },
                "case_ids": ["LLM06-tool-authorization"],
                "snapshot_digest": "f" * 64,
                "auth_identity": "synthetic-user",
                "budget": {
                    "cost_guard": "request_only",
                    "cost_acknowledged": True,
                },
            },
            headers=headers,
        )
        assert plan.status_code == 201
        approval = configured_client.post(
            f"/api/v1/plans/{plan.json()['id']}/approvals",
            json={
                "actor": "local-user",
                "acknowledgment": "I_AUTHORIZE_THIS_EXPLICIT_SCOPE",
                "ttl_minutes": 5,
            },
            headers=headers,
        )
        assert approval.status_code == 201
        queued = configured_client.post(
            f"/api/v1/plans/{plan.json()['id']}/runs",
            json={"approval_id": approval.json()["id"]},
            headers={**headers, "Idempotency-Key": "observer-api"},
        )
        assert queued.status_code == 202
        assert dispatched.wait(timeout=2)

    assert captured["root"] == tmp_path
    assert captured["run_id"] == queued.json()["run_id"]
    assert captured["observer"] is observer


def test_active_run_cancel_route_requires_csrf_and_completes_cancellation(client, monkeypatch):
    from plenger.services.active import execute_active_run as execute_active

    session = pair(client)
    headers = {
        "Origin": ORIGIN,
        "X-CSRF-Token": session["csrf_token"],
    }
    created = client.post(
        f"/api/v1/projects/{session['project_id']}/plans",
        json={
            "target": {
                "target_ref": "cancel-fixture",
                "base_url": "http://127.0.0.1:8080",
                "environment": "local",
                "allowed_paths": ["/health"],
                "allowed_methods": ["POST"],
            },
            "case_ids": ["LLM01-direct-policy"],
            "snapshot_digest": "d" * 64,
            "auth_identity": "synthetic-user",
            "budget": {
                "cost_guard": "request_only",
                "cost_acknowledged": True,
            },
        },
        headers=headers,
    )
    assert created.status_code == 201
    plan = created.json()
    approval = client.post(
        f"/api/v1/plans/{plan['id']}/approvals",
        json={
            "actor": "local-user",
            "acknowledgment": "I_AUTHORIZE_THIS_EXPLICIT_SCOPE",
            "ttl_minutes": 5,
        },
        headers=headers,
    )
    assert approval.status_code == 201

    # Keep the queued run observable while exercising the API control plane.
    monkeypatch.setattr("plenger.api.execute_active_run", lambda *args, **kwargs: None)
    active = client.post(
        f"/api/v1/plans/{plan['id']}/runs",
        json={"approval_id": approval.json()["id"]},
        headers={**headers, "Idempotency-Key": "cancel-api"},
    )
    assert active.status_code == 202
    run_id = active.json()["run_id"]

    assert (
        client.post(f"/api/v1/runs/{run_id}/cancel", headers={"Origin": ORIGIN}).status_code == 403
    )
    assert client.post("/api/v1/runs/foreign/cancel", headers=headers).status_code == 404

    requested = client.post(f"/api/v1/runs/{run_id}/cancel", headers=headers)
    assert requested.status_code == 200
    assert requested.json() == {"run_id": run_id, "state": "cancelling"}

    completed = execute_active(client.app.state.project_root, run_id)
    assert completed["state"] == "cancelled"
    assert client.get(f"/api/v1/runs/{run_id}").json()["state"] == "cancelled"


def test_unavailable_active_runner_is_rejected_before_approval_consumption(client, monkeypatch):
    from plenger.services import active as active_service

    session = pair(client)
    headers = {
        "Origin": ORIGIN,
        "X-CSRF-Token": session["csrf_token"],
    }
    created = client.post(
        f"/api/v1/projects/{session['project_id']}/plans",
        json={
            "target": {
                "target_ref": "unavailable-fixture",
                "base_url": "http://127.0.0.1:8080",
                "environment": "local",
                "allowed_paths": ["/health"],
                "allowed_methods": ["POST"],
            },
            "case_ids": ["LLM01-direct-policy"],
            "snapshot_digest": "c" * 64,
            "auth_identity": "synthetic-user",
            "budget": {
                "cost_guard": "request_only",
                "cost_acknowledged": True,
            },
        },
        headers=headers,
    )
    assert created.status_code == 201
    plan = created.json()
    approval = client.post(
        f"/api/v1/plans/{plan['id']}/approvals",
        json={
            "actor": "local-user",
            "acknowledgment": "I_AUTHORIZE_THIS_EXPLICIT_SCOPE",
            "ttl_minutes": 5,
        },
        headers=headers,
    )
    assert approval.status_code == 201
    monkeypatch.setattr(
        active_service,
        "active_runner_capability",
        lambda: {"status": "unavailable", "reason": "posix_unix_socket_required"},
    )

    rejected = client.post(
        f"/api/v1/plans/{plan['id']}/runs",
        json={"approval_id": approval.json()["id"]},
        headers={**headers, "Idempotency-Key": "unavailable-api"},
    )
    assert rejected.status_code == 503
    assert rejected.json()["code"] == "active_runner_unavailable"
    assert client.get(f"/api/v1/plans/{plan['id']}").json()["state"] == "approved"


def test_strict_cost_guard_is_rejected_before_active_queue(client):
    session = pair(client)
    headers = {
        "Origin": ORIGIN,
        "X-CSRF-Token": session["csrf_token"],
    }
    path = f"/api/v1/projects/{session['project_id']}/plans"
    created = client.post(
        path,
        json={
            "target": {
                "target_ref": "strict-fixture",
                "base_url": "http://127.0.0.1:8080",
                "environment": "local",
                "allowed_paths": ["/health"],
                "allowed_methods": ["GET"],
            },
            "case_ids": ["LLM01-direct-policy"],
            "snapshot_digest": "b" * 64,
            "auth_identity": "synthetic-user",
            "budget": {"cost_guard": "strict"},
        },
        headers=headers,
    )
    assert created.status_code == 422
    assert created.json()["code"] == "strict_cost_guard_requires_target_control"


def test_inline_hosted_consent_requires_explicit_acknowledgment(client):
    session = pair(client)
    headers = {"Origin": ORIGIN, "X-CSRF-Token": session["csrf_token"]}

    response = client.post(
        f"/api/v1/runs/{uuid.uuid4()}/assessments",
        json={"finding_id": "a" * 64, "provider": "jev", "consent": True},
        headers=headers,
    )

    assert response.status_code == 422
    assert response.json()["code"] == "hosted_consent_acknowledgment_required"
    preview = client.get("/api/v1/assessment-consent").json()
    assert preview["granted"] is False


def test_exhausted_pairing_code_rotates_to_a_terminal_only_code(monkeypatch):
    from plenger import api as api_module

    announced: list[str] = []
    sessions = Sessions(announce=announced.append)
    original = sessions.code
    for _ in range(5):
        assert sessions.pair("wrong") is None
    assert sessions.rate_limited()
    # Rotation is rate limited, so repeated failures cannot churn codes quickly.
    assert sessions.pair(original) is None
    assert announced == []

    monkeypatch.setattr(api_module, "PAIRING_ROTATION_COOLDOWN_SECONDS", 0.0)
    assert sessions.pair(original) is None
    assert len(announced) == 1 and announced[0] == sessions.code != original
    assert sessions.pair(original) is None
    assert sessions.pair(sessions.code) is not None


def test_server_port_is_part_of_host_and_origin_checks(tmp_path):
    initialize(tmp_path)
    origin = "http://127.0.0.1:8123"
    client = TestClient(create_app(tmp_path, port=8123), base_url=origin)
    assert client.get("/api/v1/health").status_code == 200
    default_origin = client.post(
        "/api/v1/pair", json={"code": client.app.state.pairing.code}, headers={"Origin": ORIGIN}
    )
    assert default_origin.status_code == 403
    paired = client.post(
        "/api/v1/pair", json={"code": client.app.state.pairing.code}, headers={"Origin": origin}
    )
    assert paired.status_code == 200
    wrong_host = TestClient(create_app(tmp_path, port=8123), base_url=ORIGIN)
    assert wrong_host.get("/api/v1/health").status_code == 403
