"""Add immutable dataset versions."""

from alembic import op
import sqlalchemy as sa

revision = "0003_dataset_versions"
down_revision = "0002_stage_a_safety"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if "dataset_versions" not in inspector.get_table_names():
        op.create_table(
            "dataset_versions",
            sa.Column("id", sa.String(length=36), primary_key=True),
            sa.Column("project_id", sa.String(length=36), nullable=False),
            sa.Column("version", sa.Integer(), nullable=False),
            sa.Column("status", sa.String(length=30), nullable=False),
            sa.Column("checksum", sa.String(length=64), nullable=False),
            sa.Column("categories", sa.JSON(), nullable=False),
            sa.Column("manifest", sa.JSON(), nullable=False),
            sa.Column("snapshot_path", sa.String(length=1000), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        )
        op.create_index("ix_dataset_versions_project_id", "dataset_versions", ["project_id"])
    model_columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("model_versions")}
    if "dataset_version_id" not in model_columns:
        op.add_column("model_versions", sa.Column("dataset_version_id", sa.String(length=36), nullable=True))


def downgrade() -> None:
    pass
