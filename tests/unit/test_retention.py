import json

import pytest
from sqlalchemy import text

from plenger.services.application import project_id, queue_scan
from plenger.services.workspace import initialize
from plenger.storage import open_store
from plenger.storage.retention import purge_expired_metadata


def test_metadata_retention_purges_terminal_run_children_but_keeps_active_data(tmp_path):
    initialize(tmp_path)
    old_run, _ = queue_scan(tmp_path, "deterministic", False, "retention-old")
    active_run, _ = queue_scan(tmp_path, "deterministic", False, "retention-active")
    identity = project_id(tmp_path)
    old_timestamp = "2020-01-01T00:00:00+00:00"
    old_evidence = "e" * 64
    old_finding = "f" * 64
    old_snapshot = "s" * 36
    old_plan = "p" * 36
    old_approval = "a" * 36
    old_suppression = "q" * 36
    active_suppression = "r" * 36
    old_consent = "c" * 36
    active_consent = "d" * 36

    engine = open_store(tmp_path)
    try:
        with engine.begin() as connection:
            connection.execute(
                text(
                    "UPDATE runs SET state='completed',created_at=:created,updated_at=:created "
                    "WHERE id=:run"
                ),
                {"created": old_timestamp, "run": old_run},
            )
            connection.execute(
                text(
                    "UPDATE runs SET state='running',created_at=:created,updated_at=:created "
                    "WHERE id=:run"
                ),
                {"created": old_timestamp, "run": active_run},
            )
            connection.execute(
                text(
                    "INSERT INTO snapshots (id,run_id,project_id,manifest_digest,payload) "
                    "VALUES (:id,:run,:project,:digest,:payload)"
                ),
                {
                    "id": old_snapshot,
                    "run": old_run,
                    "project": identity,
                    "digest": "1" * 64,
                    "payload": "{}",
                },
            )
            connection.execute(
                text("INSERT INTO reports (id,project_id,payload) VALUES (:id,:project,:payload)"),
                {"id": old_run, "project": identity, "payload": json.dumps({"run_id": old_run})},
            )
            connection.execute(
                text(
                    "INSERT INTO evidence_artifacts "
                    "(id,run_id,project_id,source,observed,redaction_version,sha256_redacted,"
                    "mime,size,retention_until,created_at) VALUES "
                    "(:id,:run,:project,'fixture','evidence','v1',:digest,'text/plain',8,:retention,:created)"
                ),
                {
                    "id": old_evidence,
                    "run": old_run,
                    "project": identity,
                    "digest": "2" * 64,
                    "retention": old_timestamp,
                    "created": old_timestamp,
                },
            )
            connection.execute(
                text(
                    "INSERT INTO finding_records "
                    "(id,run_id,project_id,snapshot_id,fingerprint,rule_id,kind,severity,"
                    "severity_source,validation_state,lifecycle_state,assessment_state,title,"
                    "source_path,source_line,revision,created_at,updated_at) VALUES "
                    "(:id,:run,:project,:snapshot,:fingerprint,'rule','kind','high','rule',"
                    "'candidate','open','needs_review','title','fixture.py',1,0,:created,:created)"
                ),
                {
                    "id": old_finding,
                    "run": old_run,
                    "project": identity,
                    "snapshot": old_snapshot,
                    "fingerprint": "3" * 64,
                    "created": old_timestamp,
                },
            )
            connection.execute(
                text(
                    "INSERT INTO finding_evidence "
                    "(finding_id,evidence_id,project_id,evidence_order) "
                    "VALUES (:finding,:evidence,:project,0)"
                ),
                {"finding": old_finding, "evidence": old_evidence, "project": identity},
            )
            connection.execute(
                text(
                    "INSERT INTO graph_nodes "
                    "(entity_key,run_id,project_id,snapshot_id,node_id,kind,label,source_path,"
                    "source_line,provenance,attributes) VALUES "
                    "(:key,:run,:project,:snapshot,'node','function','node','fixture.py',1,'fixture','{}')"
                ),
                {
                    "key": "n" * 64,
                    "run": old_run,
                    "project": identity,
                    "snapshot": old_snapshot,
                },
            )
            connection.execute(
                text(
                    "INSERT INTO graph_edges "
                    "(entity_key,run_id,project_id,snapshot_id,edge_id,source_id,target_id,kind,"
                    "source_path,source_line,provenance) VALUES "
                    "(:key,:run,:project,:snapshot,'edge','node','node','calls','fixture.py',1,'fixture')"
                ),
                {
                    "key": "g" * 64,
                    "run": old_run,
                    "project": identity,
                    "snapshot": old_snapshot,
                },
            )
            connection.execute(
                text(
                    "INSERT INTO assessments "
                    "(id,project_id,run_id,finding_id,evaluator,state,reason_code,requested_model,"
                    "resolved_model,rubric_hash,inputs_digest,redaction_version,payload,"
                    "created_at) VALUES (:id,:project,:run,:finding,'manual','reviewed','fixture',"
                    "NULL,NULL,:rubric,"
                    ":inputs,'v1','{}',:created)"
                ),
                {
                    "id": "m" * 36,
                    "project": identity,
                    "run": old_run,
                    "finding": old_finding,
                    "rubric": "4" * 64,
                    "inputs": "5" * 64,
                    "created": old_timestamp,
                },
            )
            connection.execute(
                text(
                    "INSERT INTO active_attempts "
                    "(id,run_id,project_id,attempt_index,case_id,category,result,reason_code,"
                    "http_status,evidence,created_at) VALUES "
                    "(:id,:run,:project,0,'LLM01','LLM01','pass','fixture',200,'[]',:created)"
                ),
                {
                    "id": "t" * 36,
                    "run": old_run,
                    "project": identity,
                    "created": old_timestamp,
                },
            )
            connection.execute(
                text(
                    "INSERT INTO finding_suppressions "
                    "(id,project_id,finding_fingerprint,actor,reason,scope_fingerprint,evidence_id,"
                    "created_at,expires_at,revoked_at) VALUES "
                    "(:id,:project,:fingerprint,'reviewer','old',:scope,:evidence,:created,:expires,NULL)"
                ),
                {
                    "id": old_suppression,
                    "project": identity,
                    "fingerprint": "3" * 64,
                    "scope": "3" * 64,
                    "evidence": old_evidence,
                    "created": old_timestamp,
                    "expires": old_timestamp,
                },
            )
            connection.execute(
                text(
                    "INSERT INTO finding_suppressions "
                    "(id,project_id,finding_fingerprint,actor,reason,scope_fingerprint,evidence_id,"
                    "created_at,expires_at,revoked_at) VALUES "
                    "(:id,:project,:fingerprint,'reviewer','active',:scope,:evidence,:created,:expires,NULL)"
                ),
                {
                    "id": active_suppression,
                    "project": identity,
                    "fingerprint": "4" * 64,
                    "scope": "4" * 64,
                    "evidence": old_evidence,
                    "created": old_timestamp,
                    "expires": "2020-06-01T00:00:00+00:00",
                },
            )
            connection.execute(
                text(
                    "INSERT INTO plans "
                    "(id,project_id,snapshot_digest,plan_digest,scope_digest,profile,payload,state,"
                    "revision,created_at,updated_at) VALUES "
                    "(:id,:project,:snapshot,:digest,:scope,'active','{}','revoked',0,:created,:created)"
                ),
                {
                    "id": old_plan,
                    "project": identity,
                    "snapshot": "6" * 64,
                    "digest": "7" * 64,
                    "scope": "8" * 64,
                    "created": old_timestamp,
                },
            )
            connection.execute(
                text(
                    "INSERT INTO approvals "
                    "(id,plan_id,project_id,plan_digest,scope_digest,actor,expires_at,consumed_at,"
                    "revoked_at,created_at) VALUES "
                    "(:id,:plan,:project,:digest,:scope,'reviewer',:expires,NULL,:revoked,:created)"
                ),
                {
                    "id": old_approval,
                    "plan": old_plan,
                    "project": identity,
                    "digest": "7" * 64,
                    "scope": "8" * 64,
                    "expires": old_timestamp,
                    "revoked": old_timestamp,
                    "created": old_timestamp,
                },
            )
            for consent_id, config_hash, revoked_at in (
                (old_consent, "9" * 64, old_timestamp),
                (active_consent, "a" * 64, None),
            ):
                connection.execute(
                    text(
                        "INSERT INTO hosted_consents "
                        "(id,project_id,config_hash,provider,data_classes,domain,actor,"
                        "created_at,revoked_at) "
                        "VALUES (:id,:project,:config,'jev','[\"metadata\"]','api.typesafe.ai',"
                        "'reviewer',:created,:revoked)"
                    ),
                    {
                        "id": consent_id,
                        "project": identity,
                        "config": config_hash,
                        "created": old_timestamp,
                        "revoked": revoked_at,
                    },
                )

        counts = purge_expired_metadata(
            engine,
            identity,
            now_value="2020-05-01T00:00:00+00:00",
        )
        assert counts["runs"] == 1
        with engine.connect() as connection:
            assert (
                connection.execute(
                    text("SELECT id FROM runs WHERE id=:id"), {"id": old_run}
                ).first()
                is None
            )
            assert (
                connection.execute(
                    text("SELECT id FROM runs WHERE id=:id"), {"id": active_run}
                ).first()
                is not None
            )
            assert (
                connection.execute(
                    text("SELECT COUNT(*) FROM reports WHERE id=:run"), {"run": old_run}
                ).scalar_one()
                == 0
            )
            for table in (
                "snapshots",
                "evidence_artifacts",
                "finding_records",
                "graph_nodes",
                "graph_edges",
                "assessments",
                "active_attempts",
            ):
                assert (
                    connection.execute(
                        text(f"SELECT COUNT(*) FROM {table} WHERE run_id=:run"), {"run": old_run}
                    ).scalar_one()
                    == 0
                )
            assert (
                connection.execute(
                    text("SELECT COUNT(*) FROM finding_evidence WHERE finding_id=:finding"),
                    {"finding": old_finding},
                ).scalar_one()
                == 0
            )
            assert (
                connection.execute(
                    text("SELECT id FROM finding_suppressions WHERE id=:id"),
                    {"id": old_suppression},
                ).first()
                is None
            )
            retained_suppression = connection.execute(
                text("SELECT evidence_id FROM finding_suppressions WHERE id=:id"),
                {"id": active_suppression},
            ).first()
            assert retained_suppression is not None
            assert retained_suppression[0] is None
            assert (
                connection.execute(
                    text("SELECT id FROM plans WHERE id=:id"), {"id": old_plan}
                ).first()
                is None
            )
            assert (
                connection.execute(
                    text("SELECT id FROM approvals WHERE id=:id"), {"id": old_approval}
                ).first()
                is None
            )
            assert (
                connection.execute(
                    text("SELECT id FROM hosted_consents WHERE id=:id"), {"id": old_consent}
                ).first()
                is None
            )
            assert (
                connection.execute(
                    text("SELECT id FROM hosted_consents WHERE id=:id"), {"id": active_consent}
                ).first()
                is not None
            )
    finally:
        engine.dispose()


def test_metadata_retention_rejects_invalid_window(tmp_path):
    initialize(tmp_path)
    engine = open_store(tmp_path)
    try:
        with pytest.raises(ValueError, match="invalid_metadata_retention_days"):
            purge_expired_metadata(engine, project_id(tmp_path), retention_days=0)
    finally:
        engine.dispose()
