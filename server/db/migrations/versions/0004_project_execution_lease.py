"""Add database-level per-project execution leases."""

from alembic import op
import sqlalchemy as sa

revision = "0004_project_execution_lease"
down_revision = "0003_dataset_versions"
branch_labels = None
depends_on = None


def upgrade() -> None:
    if "project_execution_leases" not in sa.inspect(op.get_bind()).get_table_names():
        op.create_table(
            "project_execution_leases",
            sa.Column("project_id", sa.String(length=36), primary_key=True),
            sa.Column("task_id", sa.String(length=36), nullable=False, unique=True),
            sa.Column("acquired_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        )


def downgrade() -> None:
    pass
