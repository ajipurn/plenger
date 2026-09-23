"""Preserve primary and additional evidence order for normalized findings."""

import sqlalchemy as sa
from alembic import op

revision = "0010"
down_revision = "0009"


def upgrade() -> None:
    op.add_column(
        "finding_evidence",
        sa.Column("evidence_order", sa.Integer(), nullable=False, server_default="0"),
    )


def downgrade() -> None:
    raise RuntimeError("rollback_requires_backup_and_explicit_data_migration")
