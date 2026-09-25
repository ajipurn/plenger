import json
from datetime import UTC, datetime, timedelta

from sqlalchemy import text

from plenger.services.application import (
    findings_page,
    latest,
    project_id,
    queue_scan,
    update_finding_lifecycle,
)
from plenger.services.workspace import initialize
from plenger.storage import open_store
from plenger.storage.findings import (
    active_suppression,
    latest_suppression,
    normalized_findings,
    persist_report_entities,
)
from plenger.storage.graph import graph_page, persist_graph_entities


def test_normalized_findings_are_project_bound_and_revisioned(tmp_path, monkeypatch):
    from plenger.services import application

    initialize(tmp_path)
    (tmp_path / "fixture.py").write_text("def f(x): return eval(x)")
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
                        "observed": "safe synthetic evidence",
                        "redaction_version": "metadata-only-v1",
                    },
                    "evidence_refs": [
                        {
                            "id": "d" * 64,
                            "source": "semgrep",
                            "observed": "second normalized scanner evidence",
                            "redaction_version": "metadata-only-v1",
                        }
                    ],
                }
            ],
            "errors": [],
            "limitations": [],
        },
    )
    run_id, _ = queue_scan(tmp_path, "deterministic", False, "normalized")
    application.execute_scan(tmp_path, run_id)
    first_report = latest(tmp_path, run_id)
    assert first_report and first_report["findings"]
    first_finding_id = first_report["findings"][0]["id"]
    engine = open_store(tmp_path)
    try:
        rows = normalized_findings(engine, project_id(tmp_path), run_id)
        assert len(rows) == 1
        assert rows[0]["evidence"]["observed"] == "safe synthetic evidence"
        assert len(rows[0]["evidence_refs"]) == 2
        paged_rows = normalized_findings(engine, project_id(tmp_path), run_id, limit=1)
        assert len(paged_rows) == 1 and len(paged_rows[0]["evidence_refs"]) == 2
        with engine.connect() as connection:
            assert connection.execute(text("SELECT COUNT(*) FROM finding_records")).scalar() == 1
            assert connection.execute(text("SELECT COUNT(*) FROM evidence_artifacts")).scalar() == 2
    finally:
        engine.dispose()
    page = findings_page(tmp_path, limit=1)
    assert len(page) == 1
    assert "project_id" not in page[0]
    assert page[0]["source_ref"] == {"path": "fixture.py", "line": 1}
    assert len(page[0]["evidence_refs"]) == 2
    second_run, _ = queue_scan(tmp_path, "deterministic", False, "normalized-second")
    second_report = application.execute_scan(tmp_path, second_run)
    assert second_report["findings"][0]["id"] != first_finding_id
    engine = open_store(tmp_path)
    try:
        with engine.connect() as connection:
            assert connection.execute(text("SELECT COUNT(*) FROM finding_records")).scalar() == 2
            assert connection.execute(text("SELECT COUNT(*) FROM evidence_artifacts")).scalar() == 4
    finally:
        engine.dispose()
    engine = open_store(tmp_path)
    try:
        with engine.begin() as connection:
            connection.execute(
                text("UPDATE evidence_artifacts SET retention_until='2000-01-01T00:00:00+00:00'")
            )
    finally:
        engine.dispose()
    expired = latest(tmp_path, run_id)
    assert expired and expired["findings"][0]["evidence_expired"] is True
    assert expired["findings"][0]["evidence"]["observed"] == "[EXPIRED]"
    engine = open_store(tmp_path)
    try:
        with engine.connect() as connection:
            stored_payload = connection.execute(
                text("SELECT payload FROM reports WHERE id=:run"), {"run": run_id}
            ).scalar_one()
        assert "safe synthetic evidence" not in stored_payload
        assert "[EXPIRED]" in stored_payload
    finally:
        engine.dispose()
    engine = open_store(tmp_path)
    try:
        with engine.begin() as connection:
            payload = json.loads(
                connection.execute(
                    text("SELECT payload FROM reports WHERE id=:run"), {"run": run_id}
                ).scalar_one()
            )
            payload["secretKey"] = "plain-synthetic-secret"
            connection.execute(
                text("UPDATE reports SET payload=:payload WHERE id=:run"),
                {"payload": json.dumps(payload), "run": run_id},
            )
    finally:
        engine.dispose()
    updated = update_finding_lifecycle(
        tmp_path, first_finding_id, "acknowledged", "triaged by reviewer", 0
    )
    assert updated and updated["revision"] == 1
    engine = open_store(tmp_path)
    try:
        with engine.connect() as connection:
            persisted = connection.execute(
                text("SELECT payload FROM reports WHERE id=:run"), {"run": run_id}
            ).scalar_one()
        assert "plain-synthetic-secret" not in persisted
    finally:
        engine.dispose()
    assert (
        update_finding_lifecycle(tmp_path, first_finding_id, "resolved", "stale revision", 0)
        is None
    )
    suppressed = update_finding_lifecycle(
        tmp_path,
        first_finding_id,
        "suppressed",
        "accepted fixture-only risk sk-secret-SYNTHETIC0123456789",
        1,
        actor="reviewer",
        expiry_days=7,
    )
    assert suppressed and suppressed["revision"] == 2
    engine = open_store(tmp_path)
    try:
        suppression = active_suppression(engine, project_id(tmp_path), "b" * 64)
        assert suppression and "SYNTHETIC" not in suppression["reason"]
        assert latest_suppression(engine, project_id(tmp_path), "b" * 64)
        with engine.begin() as connection:
            connection.execute(
                text(
                    "UPDATE finding_suppressions SET expires_at=:expires_at "
                    "WHERE finding_fingerprint=:fingerprint"
                ),
                {
                    "expires_at": (datetime.now(UTC) - timedelta(minutes=1)).isoformat(),
                    "fingerprint": "b" * 64,
                },
            )
        expired_suppression = latest(tmp_path, run_id)
        assert expired_suppression
        assert expired_suppression["findings"][0].get("suppression") is None
        assert expired_suppression["findings"][0]["suppression_state"] == "expired"
    finally:
        engine.dispose()


def test_execute_scan_redacts_final_storage_boundary(tmp_path, monkeypatch):
    from plenger.services import application

    initialize(tmp_path)
    (tmp_path / "fixture.py").write_text("def f(x): return eval(x)")
    monkeypatch.setattr(application, "probe", lambda: {"status": "ready"})
    monkeypatch.setattr(
        application,
        "execute",
        lambda files, identity, run_id: {
            "nodes": [],
            "edges": [],
            "findings": [],
            "errors": [],
            "limitations": [],
        },
    )
    original_manifest = application.manifest

    def unsafe_manifest(*args, **kwargs):
        snapshot = original_manifest(*args, **kwargs)
        snapshot["secretKey"] = "plain-synthetic-snapshot-secret"
        return snapshot

    monkeypatch.setattr(application, "manifest", unsafe_manifest)
    original_scope = application._scope_report_entity_ids

    def unsafe_scope(report, run_id):
        original_scope(report, run_id)
        report["secretKey"] = "plain-synthetic-report-secret"

    monkeypatch.setattr(application, "_scope_report_entity_ids", unsafe_scope)

    run_id, _ = queue_scan(tmp_path, "deterministic", False, "final-redaction-boundary")
    report = application.execute_scan(tmp_path, run_id)
    engine = open_store(tmp_path)
    try:
        with engine.connect() as connection:
            snapshot_payload = connection.execute(
                text("SELECT payload FROM snapshots WHERE run_id=:run"), {"run": run_id}
            ).scalar_one()
            report_payload = connection.execute(
                text("SELECT payload FROM reports WHERE id=:run"), {"run": run_id}
            ).scalar_one()
    finally:
        engine.dispose()

    assert report["secretKey"] == "[REDACTED]"
    assert report["snapshot"]["secretKey"] == "[REDACTED]"
    assert "plain-synthetic-snapshot-secret" not in snapshot_payload
    assert "plain-synthetic-report-secret" not in report_payload


def test_normalized_persistence_redacts_untrusted_report_payload(tmp_path):
    initialize(tmp_path)
    run_id, _ = queue_scan(tmp_path, "deterministic", False, "normalized-raw-boundary")
    identity = project_id(tmp_path)
    snapshot_id = "snapshot-raw-boundary"
    raw_report = {
        "run_id": run_id,
        "project_id": identity,
        "snapshot_id": snapshot_id,
        "findings": [
            {
                "id": "f" * 64,
                "fingerprint": "g" * 64,
                "rule_id": "WK-RAW-001",
                "kind": "secret",
                "severity": "high",
                "severity_source": "synthetic",
                "validation_state": "candidate",
                "lifecycle_state": "open",
                "assessment_state": "needs_review",
                "title": "Raw boundary test",
                "source_ref": {"path": "fixture.py", "line": 1},
                "evidence": {
                    "id": "e" * 64,
                    "source": "synthetic",
                    "observed": {"secretKey": "plain-synthetic-normalized-secret"},
                    "redaction_version": "metadata-only-v1",
                    "sha256_redacted": "h" * 64,
                },
            }
        ],
    }
    engine = open_store(tmp_path)
    try:
        with engine.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO snapshots "
                    "(id,run_id,project_id,manifest_digest,payload) "
                    "VALUES (:id,:run,:project,:digest,:payload)"
                ),
                {
                    "id": snapshot_id,
                    "run": run_id,
                    "project": identity,
                    "digest": "i" * 64,
                    "payload": "{}",
                },
            )
            persist_report_entities(connection, raw_report)
        with engine.connect() as connection:
            stored = connection.execute(
                text("SELECT observed FROM evidence_artifacts WHERE id=:id"),
                {"id": "e" * 64},
            ).scalar_one()
        with engine.begin() as connection:
            connection.execute(
                text("UPDATE evidence_artifacts SET observed=:observed WHERE id=:id"),
                {
                    "observed": "sk-synthetic-read-secret123456",
                    "id": "e" * 64,
                },
            )
        loaded = normalized_findings(engine, identity, run_id)
    finally:
        engine.dispose()

    assert "plain-synthetic-normalized-secret" not in stored
    assert "[REDACTED]" in stored
    assert loaded[0]["evidence"]["observed"] == "[REDACTED]"


def test_suppression_readers_redact_tampered_metadata(tmp_path):
    from datetime import UTC, datetime, timedelta

    initialize(tmp_path)
    identity = project_id(tmp_path)
    fingerprint = "a" * 64
    marker = "sk-synthetic-suppression-secret123456"
    created = datetime.now(UTC).isoformat()
    expires = (datetime.now(UTC) + timedelta(days=1)).isoformat()
    engine = open_store(tmp_path)
    try:
        with engine.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO finding_suppressions "
                    "(id,project_id,finding_fingerprint,actor,reason,scope_fingerprint,"
                    "evidence_id,created_at,expires_at,revoked_at) "
                    "VALUES (:id,:project,:fingerprint,:actor,:reason,:scope,NULL,:created,"
                    ":expires,NULL)"
                ),
                {
                    "id": "s" * 36,
                    "project": identity,
                    "fingerprint": fingerprint,
                    "actor": marker,
                    "reason": marker,
                    "scope": fingerprint,
                    "created": created,
                    "expires": expires,
                },
            )
        active = active_suppression(engine, identity, fingerprint)
        historical = latest_suppression(engine, identity, fingerprint)
    finally:
        engine.dispose()

    assert active and active["actor"] == "[REDACTED]" and active["reason"] == "[REDACTED]"
    assert historical and historical["actor"] == "[REDACTED]"


def test_graph_persistence_redacts_untrusted_metadata(tmp_path):
    initialize(tmp_path)
    run_id, _ = queue_scan(tmp_path, "deterministic", False, "graph-raw-boundary")
    identity = project_id(tmp_path)
    snapshot_id = "snapshot-graph-raw-boundary"
    marker = "sk-synthetic-graph-label123456"
    report = {
        "run_id": run_id,
        "project_id": identity,
        "snapshot_id": snapshot_id,
        "nodes": [
            {
                "id": "node-1",
                "kind": "symbol",
                "label": marker,
                "source_ref": {"path": "fixture.py", "line": 1},
                "provenance": "observed_static",
                "attributes": {"secretKey": "plain-synthetic-graph-attribute"},
            },
            {
                "id": "node-2",
                "kind": "symbol",
                "label": "safe-target",
                "source_ref": {"path": "fixture.py", "line": 2},
                "provenance": marker,
            },
        ],
        "edges": [
            {
                "id": "edge-1",
                "source": "node-1",
                "target": "node-2",
                "kind": "calls",
                "source_ref": {"path": "fixture.py", "line": 1},
                "provenance": marker,
            }
        ],
    }
    engine = open_store(tmp_path)
    try:
        with engine.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO snapshots "
                    "(id,run_id,project_id,manifest_digest,payload) "
                    "VALUES (:id,:run,:project,:digest,:payload)"
                ),
                {
                    "id": snapshot_id,
                    "run": run_id,
                    "project": identity,
                    "digest": "a" * 64,
                    "payload": "{}",
                },
            )
            persist_graph_entities(connection, report)
        with engine.connect() as connection:
            stored = connection.execute(
                text("SELECT label,provenance FROM graph_nodes WHERE run_id=:run ORDER BY node_id"),
                {"run": run_id},
            ).all()
            stored_edge = connection.execute(
                text("SELECT provenance FROM graph_edges WHERE run_id=:run"), {"run": run_id}
            ).scalar_one()
        loaded = graph_page(engine, identity, run_id)
    finally:
        engine.dispose()

    assert marker not in str(stored)
    assert marker not in stored_edge
    assert loaded["nodes"][0]["label"] == "[REDACTED]"
    assert loaded["nodes"][1]["provenance"] == "[REDACTED]"
    assert loaded["edges"][0]["provenance"] == "[REDACTED]"


def test_baseline_scan_is_incomplete_when_a_dependency_input_is_skipped(tmp_path, monkeypatch):
    from plenger.services import application

    initialize(tmp_path)
    (tmp_path / "plenger.yaml").write_text(
        "schema_version: 1\nprofile: baseline\nmax_file_bytes: 64\n"
    )
    (tmp_path / "app.py").write_text("value = 1\n")
    (tmp_path / "package-lock.json").write_text("{" + '"x": 1,' * 40 + '"y": 2}')
    monkeypatch.setattr(application, "probe", lambda: {"status": "ready"})
    monkeypatch.setattr(
        application,
        "execute",
        lambda files, identity, run_id: {
            "nodes": [],
            "edges": [],
            "findings": [],
            "errors": [],
            "limitations": [],
        },
    )
    monkeypatch.setattr(
        application,
        "run_managed_scanners",
        lambda root, files: ([], {"osv": {"status": "completed", "reason": "ok"}}),
    )
    run_id, _ = queue_scan(tmp_path, "baseline", False, "skipped-lockfile")

    report = application.execute_scan(tmp_path, run_id)

    assert {"path": "package-lock.json", "reason": "too_large"} in report["skipped"]
    assert {"engine": "osv", "reason": "dependency_input_skipped"} in report["scanner_errors"]
    assert report["state"] == "completed_with_errors"


def test_broader_redaction_rules_do_not_turn_intact_evidence_into_mismatch(tmp_path, monkeypatch):
    import re

    from plenger import policy
    from plenger.services import application

    initialize(tmp_path)
    (tmp_path / "fixture.py").write_text("value = 1\n")
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
                        "observed": "future-sensitive-value observed",
                        "redaction_version": "metadata-only-v1",
                    },
                }
            ],
            "errors": [],
            "limitations": [],
        },
    )
    run_id, _ = queue_scan(tmp_path, "deterministic", False, "redaction-upgrade")
    application.execute_scan(tmp_path, run_id)
    assert latest(tmp_path, run_id)["findings"][0]["evidence_integrity"] == "verified"

    # A later release adds a broader rule that matches already-stored evidence.
    monkeypatch.setattr(
        policy, "PATTERNS", [*policy.PATTERNS, re.compile(r"future-sensitive-value")]
    )
    current = latest(tmp_path, run_id)
    finding = current["findings"][0]
    assert finding["evidence_integrity"] == "verified"
    assert "future-sensitive-value" not in finding["evidence"]["observed"]

    update_finding_lifecycle(tmp_path, finding["id"], "acknowledged", "triaged", 0)
    rewritten = latest(tmp_path, run_id)["findings"][0]
    assert rewritten["evidence_integrity"] == "verified"


def test_report_write_back_keeps_tampered_evidence_visible(tmp_path, monkeypatch):
    from plenger.services.integrity import redact_preserving_integrity
    from plenger.storage.findings import evidence_digest

    evidence = {"id": "e1", "source": "s", "observed": "original", "redaction_version": "v"}
    evidence["sha256_redacted"] = evidence_digest(evidence)
    tampered = dict(evidence, observed="changed after write")
    report = {"findings": [{"evidence": tampered}]}

    rewritten = redact_preserving_integrity(report)

    assert rewritten["findings"][0]["evidence"]["sha256_redacted"] == evidence["sha256_redacted"]


def test_recurring_findings_keep_acknowledgment_and_active_suppression(tmp_path, monkeypatch):
    from plenger.services import application

    initialize(tmp_path)
    (tmp_path / "fixture.py").write_text("value = 1\n")
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
                        "observed": "synthetic evidence",
                        "redaction_version": "metadata-only-v1",
                    },
                }
            ],
            "errors": [],
            "limitations": [],
        },
    )

    def scan(key):
        run_id, _ = queue_scan(tmp_path, "deterministic", False, key)
        report = application.execute_scan(tmp_path, run_id)
        return run_id, report["findings"][0]

    _, first = scan("triage-1")
    update_finding_lifecycle(tmp_path, first["id"], "acknowledged", "known issue", 0)

    second_run, second = scan("triage-2")
    assert second["lifecycle_state"] == "acknowledged"
    page = findings_page(tmp_path)
    assert page[0]["lifecycle_state"] == "acknowledged"

    update_finding_lifecycle(tmp_path, second["id"], "suppressed", "accepted risk", 0)
    third_run, third = scan("triage-3")
    assert third["lifecycle_state"] == "suppressed"
    assert (
        application.ci_exit_code(latest(tmp_path, third_run), "high", include_candidates=True) == 0
    )

    engine = open_store(tmp_path)
    try:
        with engine.begin() as connection:
            connection.execute(text("UPDATE finding_suppressions SET revoked_at=expires_at"))
    finally:
        engine.dispose()
    update_finding_lifecycle(tmp_path, third["id"], "resolved", "fixed upstream", 0)
    _, fourth = scan("triage-4")
    assert fourth["lifecycle_state"] == "open"
    assert second_run != third_run


def test_evidence_expiry_rewrites_only_affected_mirrors_once(tmp_path, monkeypatch):
    from plenger.services import application

    initialize(tmp_path)
    (tmp_path / "fixture.py").write_text("value = 1\n")
    monkeypatch.setattr(application, "probe", lambda: {"status": "ready"})

    def fake(label):
        return lambda files, identity, run_id: {
            "nodes": [],
            "edges": [],
            "findings": [
                {
                    "id": label * 64,
                    "fingerprint": label * 64,
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
                        "id": label * 64,
                        "source": "python-ast-v2",
                        "observed": f"evidence {label}",
                        "redaction_version": "metadata-only-v1",
                    },
                }
            ],
            "errors": [],
            "limitations": [],
        }

    runs = []
    for label in ("a", "b"):
        monkeypatch.setattr(application, "execute", fake(label))
        run_id, _ = queue_scan(tmp_path, "deterministic", False, f"expiry-{label}")
        application.execute_scan(tmp_path, run_id)
        runs.append(run_id)
    expired_run, current_run = runs
    engine = open_store(tmp_path)
    try:
        with engine.begin() as connection:
            connection.execute(
                text("UPDATE evidence_artifacts SET retention_until=:past WHERE run_id=:run"),
                {"past": "2000-01-01T00:00:00+00:00", "run": expired_run},
            )
    finally:
        engine.dispose()
    rewrites = []
    original = application.redact_preserving_integrity
    monkeypatch.setattr(
        application,
        "redact_preserving_integrity",
        lambda payload: rewrites.append(payload.get("run_id")) or original(payload),
    )

    assert latest(tmp_path, current_run)["findings"][0]["evidence"]["observed"] == "evidence b"
    assert rewrites == [expired_run]
    latest(tmp_path, current_run)
    assert rewrites == [expired_run]
    expired = latest(tmp_path, expired_run)["findings"][0]
    assert expired["evidence"]["observed"] == "[EXPIRED]"
    assert expired["evidence_integrity"] == "expired"
