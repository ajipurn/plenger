"""Add project identity, plan target revision, and durable worker lease metadata."""

import sqlalchemy as sa
from alembic import op

revision = "0008"
down_revision = "0007"


def upgrade() -> None:
    op.add_column(
        "projects",
        sa.Column("name", sa.String(128), nullable=False, server_default="plenger project"),
    )
    op.add_column(
        "projects",
        sa.Column("root_identity", sa.String(64), nullable=False, server_default="unknown"),
    )
    op.add_column(
        "projects",
        sa.Column("config_hash", sa.String(64), nullable=False, server_default="unknown"),
    )
    op.add_column("plans", sa.Column("target_revision", sa.String(64), nullable=True))
    op.add_column("runs", sa.Column("lease_owner", sa.String(128), nullable=True))
    op.add_column("runs", sa.Column("lease_expires_at", sa.Text(), nullable=True))
    op.add_column("runs", sa.Column("heartbeat_at", sa.Text(), nullable=True))
    op.add_column(
        "runs", sa.Column("attempt_index", sa.Integer(), nullable=False, server_default="0")
    )
    op.create_index("ix_runs_lease", "runs", ["project_id", "lease_expires_at"])


def downgrade() -> None:
    raise RuntimeError("rollback_requires_backup_and_explicit_data_migration")
