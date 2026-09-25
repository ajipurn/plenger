"""Allow an expired, unused approval to be replaced by a new one-use approval.

The original constraint allowed one approval per plan forever, so an approval that
expired unused stranded its plan. The replacement partial index still guarantees
at most one live (unconsumed, unrevoked) approval per plan.
"""

import sqlalchemy as sa
from alembic import op

revision = "0015"
down_revision = "0014"


def upgrade() -> None:
    with op.batch_alter_table("approvals", recreate="always") as batch:
        batch.drop_constraint("uq_approval_plan_digest", type_="unique")
    op.create_index(
        "uq_approval_live_plan",
        "approvals",
        ["plan_id"],
        unique=True,
        sqlite_where=sa.text("consumed_at IS NULL AND revoked_at IS NULL"),
    )


def downgrade() -> None:
    raise RuntimeError("rollback_requires_backup_and_explicit_data_migration")
