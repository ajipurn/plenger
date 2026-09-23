"""Normalize findings and redacted evidence while retaining report snapshots."""

import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"


def upgrade() -> None:
    op.create_table(
        "evidence_artifacts",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("run_id", sa.String(36), sa.ForeignKey("runs.id"), nullable=False),
        sa.Column("project_id", sa.String(64), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("source", sa.String(128), nullable=False),
        sa.Column("observed", sa.Text(), nullable=False),
        sa.Column("redaction_version", sa.String(64), nullable=False),
        sa.Column("sha256_redacted", sa.String(64), nullable=False),
        sa.Column("mime", sa.String(128), nullable=False, server_default="text/plain"),
        sa.Column("size", sa.Integer(), nullable=False),
        sa.Column("retention_until", sa.Text(), nullable=True),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.UniqueConstraint("run_id", "id", name="uq_evidence_run_id"),
    )
    op.create_index("ix_evidence_project_run", "evidence_artifacts", ["project_id", "run_id"])
    op.create_table(
        "finding_records",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("run_id", sa.String(36), sa.ForeignKey("runs.id"), nullable=False),
        sa.Column("project_id", sa.String(64), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("snapshot_id", sa.String(36), sa.ForeignKey("snapshots.id"), nullable=False),
        sa.Column("fingerprint", sa.String(64), nullable=False),
        sa.Column("rule_id", sa.String(128), nullable=False),
        sa.Column("kind", sa.String(128), nullable=False),
        sa.Column("severity", sa.String(16), nullable=False),
        sa.Column("severity_source", sa.String(128), nullable=False),
        sa.Column("validation_state", sa.String(32), nullable=False),
        sa.Column("lifecycle_state", sa.String(32), nullable=False),
        sa.Column("assessment_state", sa.String(32), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("source_path", sa.Text(), nullable=False),
        sa.Column("source_line", sa.Integer(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.Text(), nullable=False),
        sa.UniqueConstraint("run_id", "id", name="uq_finding_run_id"),
    )
    op.create_index(
        "ix_findings_project_fingerprint",
        "finding_records",
        ["project_id", "fingerprint"],
    )
    op.create_index("ix_findings_project_run", "finding_records", ["project_id", "run_id"])
    op.create_table(
        "finding_evidence",
        sa.Column(
            "finding_id", sa.String(64), sa.ForeignKey("finding_records.id"), primary_key=True
        ),
        sa.Column(
            "evidence_id",
            sa.String(64),
            sa.ForeignKey("evidence_artifacts.id"),
            primary_key=True,
        ),
        sa.Column("project_id", sa.String(64), sa.ForeignKey("projects.id"), nullable=False),
    )


def downgrade() -> None:
    raise RuntimeError("rollback_requires_backup_and_explicit_data_migration")
