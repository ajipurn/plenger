"""Persist typed evaluator results separately from finding lifecycle state."""

import sqlalchemy as sa
from alembic import op

revision = "0006"
down_revision = "0005"


def upgrade() -> None:
    op.create_table(
        "assessments",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(64), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("run_id", sa.String(36), sa.ForeignKey("runs.id"), nullable=False),
        sa.Column("finding_id", sa.String(64), nullable=False),
        sa.Column("evaluator", sa.String(32), nullable=False),
        sa.Column("state", sa.String(32), nullable=False),
        sa.Column("reason_code", sa.String(128), nullable=False),
        sa.Column("requested_model", sa.String(128), nullable=True),
        sa.Column("resolved_model", sa.String(128), nullable=True),
        sa.Column("rubric_hash", sa.String(64), nullable=False),
        sa.Column("inputs_digest", sa.String(64), nullable=False),
        sa.Column("redaction_version", sa.String(64), nullable=False),
        sa.Column("payload", sa.Text(), nullable=False),
        sa.Column("created_at", sa.Text(), nullable=False),
    )
    op.create_index(
        "ix_assessments_project_run", "assessments", ["project_id", "run_id", "created_at"]
    )


def downgrade() -> None:
    raise RuntimeError("rollback_requires_backup_and_explicit_data_migration")
