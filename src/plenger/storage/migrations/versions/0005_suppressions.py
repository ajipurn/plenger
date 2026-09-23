"""Track expiring, project-scoped manual suppressions."""

import sqlalchemy as sa
from alembic import op

revision = "0005"
down_revision = "0004"


def upgrade() -> None:
    op.create_table(
        "finding_suppressions",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("project_id", sa.String(64), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("finding_fingerprint", sa.String(64), nullable=False),
        sa.Column("actor", sa.String(128), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("scope_fingerprint", sa.String(64), nullable=False),
        sa.Column(
            "evidence_id", sa.String(64), sa.ForeignKey("evidence_artifacts.id"), nullable=True
        ),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("expires_at", sa.Text(), nullable=False),
        sa.Column("revoked_at", sa.Text(), nullable=True),
    )
    op.create_index(
        "ix_suppressions_project_fingerprint",
        "finding_suppressions",
        ["project_id", "finding_fingerprint", "expires_at"],
    )


def downgrade() -> None:
    raise RuntimeError("rollback_requires_backup_and_explicit_data_migration")
