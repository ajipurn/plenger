"""Link durable runs to approved plans and cancellation accounting."""

import sqlalchemy as sa
from alembic import op

revision = "0007"
down_revision = "0006"


def upgrade() -> None:
    op.add_column("runs", sa.Column("plan_id", sa.String(36), nullable=True))
    op.add_column("runs", sa.Column("approval_id", sa.String(36), nullable=True))
    op.add_column(
        "runs",
        sa.Column("cancel_requested", sa.Boolean(), nullable=False, server_default="0"),
    )
    op.add_column("runs", sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"))
    op.create_index("ix_runs_plan", "runs", ["project_id", "plan_id"])


def downgrade() -> None:
    raise RuntimeError("rollback_requires_backup_and_explicit_data_migration")
