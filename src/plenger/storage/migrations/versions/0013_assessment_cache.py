"""Index the project-scoped semantic assessment cache key."""

from alembic import op

revision = "0013"
down_revision = "0012"


def upgrade() -> None:
    op.create_index(
        "ix_assessments_semantic_cache",
        "assessments",
        [
            "project_id",
            "evaluator",
            "inputs_digest",
            "rubric_hash",
            "requested_model",
            "resolved_model",
            "redaction_version",
            "created_at",
        ],
    )


def downgrade() -> None:
    raise RuntimeError("rollback_requires_backup_and_explicit_data_migration")
