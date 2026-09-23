"""Persist graph entities separately so API pagination does not load reports."""

import sqlalchemy as sa
from alembic import op

revision = "0011"
down_revision = "0010"


def upgrade() -> None:
    op.create_table(
        "graph_nodes",
        sa.Column("entity_key", sa.String(64), primary_key=True),
        sa.Column("run_id", sa.String(36), sa.ForeignKey("runs.id"), nullable=False),
        sa.Column("project_id", sa.String(64), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("snapshot_id", sa.String(36), sa.ForeignKey("snapshots.id"), nullable=False),
        sa.Column("node_id", sa.String(128), nullable=False),
        sa.Column("kind", sa.String(128), nullable=False),
        sa.Column("label", sa.Text(), nullable=False),
        sa.Column("source_path", sa.Text(), nullable=False),
        sa.Column("source_line", sa.Integer(), nullable=False),
        sa.Column("provenance", sa.String(64), nullable=False),
        sa.Column("attributes", sa.Text(), nullable=False),
        sa.UniqueConstraint("run_id", "node_id", name="uq_graph_node_run_id"),
    )
    op.create_index("ix_graph_nodes_project_run", "graph_nodes", ["project_id", "run_id"])
    op.create_table(
        "graph_edges",
        sa.Column("entity_key", sa.String(64), primary_key=True),
        sa.Column("run_id", sa.String(36), sa.ForeignKey("runs.id"), nullable=False),
        sa.Column("project_id", sa.String(64), sa.ForeignKey("projects.id"), nullable=False),
        sa.Column("snapshot_id", sa.String(36), sa.ForeignKey("snapshots.id"), nullable=False),
        sa.Column("edge_id", sa.String(128), nullable=False),
        sa.Column("source_id", sa.String(128), nullable=False),
        sa.Column("target_id", sa.String(128), nullable=False),
        sa.Column("kind", sa.String(128), nullable=False),
        sa.Column("source_path", sa.Text(), nullable=False),
        sa.Column("source_line", sa.Integer(), nullable=False),
        sa.Column("provenance", sa.String(64), nullable=False),
        sa.UniqueConstraint("run_id", "edge_id", name="uq_graph_edge_run_id"),
    )
    op.create_index("ix_graph_edges_project_run", "graph_edges", ["project_id", "run_id"])


def downgrade() -> None:
    raise RuntimeError("rollback_requires_backup_and_explicit_data_migration")
