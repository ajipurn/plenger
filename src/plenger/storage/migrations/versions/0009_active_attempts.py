"""Persist bounded active-case attempt accounting separately from final reports."""

import sqlalchemy as sa
from alembic import op

revision = "0009"
down_revision = "0008"


def upgrade() -> None:
    op.create_table(
        "active_attempts",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("run_id", sa.String(36), sa.ForeignKey("runs.id"), nullable=False),
        sa.Column("project_id", sa.String(64), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("attempt_index", sa.Integer(), nullable=False),
        sa.Column("case_id", sa.String(128), nullable=False),
        sa.Column("category", sa.String(16), nullable=False),
        sa.Column("result", sa.String(32), nullable=False),
        sa.Column("reason_code", sa.String(128), nullable=False),
        sa.Column("http_status", sa.Integer(), nullable=True),
        sa.Column("evidence", sa.Text(), nullable=False),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.UniqueConstraint("run_id", "attempt_index", name="uq_active_attempt_index"),
    )
    op.create_index("ix_active_attempts_run", "active_attempts", ["project_id", "run_id"])


def downgrade() -> None:
    raise RuntimeError("rollback_requires_backup_and_explicit_data_migration")
