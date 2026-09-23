"""Persist project-scoped granular hosted-consent decisions."""

import sqlalchemy as sa
from alembic import op

revision = "0012"
down_revision = "0011"


def upgrade() -> None:
    op.create_table(
        "hosted_consents",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(64), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("config_hash", sa.String(64), nullable=False),
        sa.Column("provider", sa.String(32), nullable=False),
        sa.Column("data_classes", sa.Text(), nullable=False),
        sa.Column("domain", sa.String(255), nullable=False),
        sa.Column("actor", sa.String(128), nullable=False),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("revoked_at", sa.Text(), nullable=True),
        sa.UniqueConstraint(
            "project_id",
            "config_hash",
            "provider",
            "data_classes",
            "domain",
            name="uq_hosted_consent_scope",
        ),
    )
    op.create_index("ix_hosted_consents_project", "hosted_consents", ["project_id", "created_at"])


def downgrade() -> None:
    raise RuntimeError("rollback_requires_backup_and_explicit_data_migration")
