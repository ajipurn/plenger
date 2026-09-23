"""Bounded retention for project-local metadata and audit records."""

from datetime import UTC, datetime, timedelta

from sqlalchemy import text
from sqlalchemy.engine import Engine

DEFAULT_METADATA_RETENTION_DAYS = 90
_ACTIVE_RUN_STATES = "'queued','running','cancelling'"


def _retention_cutoff(now_value: str | None, retention_days: int) -> str:
    if isinstance(retention_days, bool) or not 1 <= retention_days <= 3650:
        raise ValueError("invalid_metadata_retention_days")
    if now_value is None:
        current = datetime.now(UTC)
    else:
        try:
            current = datetime.fromisoformat(now_value)
        except (TypeError, ValueError):
            raise ValueError("invalid_metadata_retention_time") from None
        if current.tzinfo is None:
            raise ValueError("invalid_metadata_retention_time")
        current = current.astimezone(UTC)
    return (current - timedelta(days=retention_days)).isoformat()


def purge_expired_metadata(
    engine: Engine,
    project_id: str,
    now_value: str | None = None,
    retention_days: int = DEFAULT_METADATA_RETENTION_DAYS,
) -> dict[str, int]:
    """Delete terminal run metadata older than the local retention window.

    Evidence content has its own shorter expiry.  This cleanup removes the
    remaining run-bound metadata only after the longer audit window and keeps
    queued/running/cancelling runs intact.  Active hosted consent is user
    configuration rather than historical audit data, so only revoked consent
    records are eligible here.
    """

    if not project_id or len(project_id) > 128:
        raise ValueError("invalid_metadata_project")
    cutoff = _retention_cutoff(now_value, retention_days)
    old_runs = (
        "SELECT id FROM runs WHERE project_id=:project AND created_at<=:cutoff "
        f"AND state NOT IN ({_ACTIVE_RUN_STATES})"
    )
    old_evidence = (
        f"SELECT id FROM evidence_artifacts WHERE project_id=:project AND run_id IN ({old_runs})"
    )
    old_findings = (
        f"SELECT id FROM finding_records WHERE project_id=:project AND run_id IN ({old_runs})"
    )

    counts: dict[str, int] = {}
    values = {"project": project_id, "cutoff": cutoff}
    with engine.begin() as connection:
        statements = (
            (
                "finding_evidence",
                f"DELETE FROM finding_evidence WHERE project_id=:project AND "
                f"(finding_id IN ({old_findings}) OR evidence_id IN ({old_evidence}))",
            ),
            (
                "finding_suppression_evidence",
                f"UPDATE finding_suppressions SET evidence_id=NULL WHERE project_id=:project "
                f"AND evidence_id IN ({old_evidence})",
            ),
            (
                "finding_suppressions",
                "DELETE FROM finding_suppressions WHERE project_id=:project AND "
                "(expires_at<=:cutoff OR (revoked_at IS NOT NULL AND revoked_at<=:cutoff))",
            ),
            (
                "evidence_artifacts",
                f"DELETE FROM evidence_artifacts WHERE project_id=:project "
                f"AND run_id IN ({old_runs})",
            ),
            (
                "finding_records",
                f"DELETE FROM finding_records WHERE project_id=:project AND run_id IN ({old_runs})",
            ),
            (
                "graph_edges",
                f"DELETE FROM graph_edges WHERE project_id=:project AND run_id IN ({old_runs})",
            ),
            (
                "graph_nodes",
                f"DELETE FROM graph_nodes WHERE project_id=:project AND run_id IN ({old_runs})",
            ),
            (
                "assessments",
                f"DELETE FROM assessments WHERE project_id=:project AND run_id IN ({old_runs})",
            ),
            (
                "active_attempts",
                f"DELETE FROM active_attempts WHERE project_id=:project AND run_id IN ({old_runs})",
            ),
            (
                "snapshots",
                f"DELETE FROM snapshots WHERE project_id=:project AND run_id IN ({old_runs})",
            ),
            (
                "run_events",
                f"DELETE FROM run_events WHERE run_id IN ({old_runs})",
            ),
            (
                "reports",
                f"DELETE FROM reports WHERE project_id=:project AND id IN ({old_runs})",
            ),
            (
                "approvals",
                "DELETE FROM approvals WHERE project_id=:project AND "
                "(created_at<=:cutoff OR plan_id IN (SELECT id FROM plans "
                "WHERE project_id=:project AND updated_at<=:cutoff)) "
                "AND NOT EXISTS (SELECT 1 FROM runs WHERE runs.approval_id=approvals.id "
                f"AND runs.state IN ({_ACTIVE_RUN_STATES}))",
            ),
            (
                "plans",
                "DELETE FROM plans WHERE project_id=:project AND updated_at<=:cutoff "
                "AND NOT EXISTS (SELECT 1 FROM runs WHERE runs.plan_id=plans.id "
                f"AND runs.state IN ({_ACTIVE_RUN_STATES}))",
            ),
            (
                "hosted_consents",
                "DELETE FROM hosted_consents WHERE project_id=:project "
                "AND revoked_at IS NOT NULL AND revoked_at<=:cutoff",
            ),
            (
                "runs",
                f"DELETE FROM runs WHERE project_id=:project AND id IN ({old_runs})",
            ),
        )
        for name, statement in statements:
            result = connection.execute(text(statement), values)
            counts[name] = max(result.rowcount, 0)
    return counts
