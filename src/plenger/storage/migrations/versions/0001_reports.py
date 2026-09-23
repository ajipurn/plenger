"""Initial append-only report store."""

import sqlalchemy as sa
from alembic import op

revision = "0001"
down_revision = None


def upgrade() -> None:
    op.create_table(
        "reports",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(64), nullable=False),
        sa.Column("payload", sa.Text(), nullable=False),
    )
    op.create_index("ix_reports_project", "reports", ["project_id"])


def downgrade() -> None:
    # Destructive rollback deliberately unsupported; preserve evidence.
    raise RuntimeError("rollback_requires_backup_and_explicit_data_migration")
