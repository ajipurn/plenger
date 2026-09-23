"""Allow a revoked or consumed plan digest to be planned again."""

from alembic import op

revision = "0014"
down_revision = "0013"


def upgrade() -> None:
    with op.batch_alter_table("plans", recreate="always") as batch:
        batch.drop_constraint("uq_plan_digest", type_="unique")


def downgrade() -> None:
    raise RuntimeError("rollback_requires_backup_and_explicit_data_migration")
