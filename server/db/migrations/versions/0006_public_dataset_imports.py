"""Add public dataset imports and frame provenance."""

from alembic import op
import sqlalchemy as sa

revision = "0006_public_dataset_imports"
down_revision = "0005_category_sort_order"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    tables = set(inspector.get_table_names())
    if "public_dataset_imports" not in tables:
        op.create_table(
            "public_dataset_imports",
            sa.Column("id", sa.String(length=36), primary_key=True),
            sa.Column("project_id", sa.String(length=36), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
            sa.Column("provider", sa.String(length=30), nullable=False),
            sa.Column("source_ref", sa.String(length=500), nullable=False),
            sa.Column("source_version", sa.String(length=100), nullable=False, server_default=""),
            sa.Column("source_url", sa.String(length=1000), nullable=False, server_default=""),
            sa.Column("title", sa.String(length=500), nullable=False, server_default=""),
            sa.Column("license_name", sa.String(length=200), nullable=False, server_default="unknown"),
            sa.Column("license_url", sa.String(length=1000), nullable=False, server_default=""),
            sa.Column("license_fingerprint", sa.String(length=64), nullable=False),
            sa.Column("license_confirmed_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("state", sa.String(length=40), nullable=False, server_default="created"),
            sa.Column("expected_download_bytes", sa.Integer(), nullable=True),
            sa.Column("actual_download_bytes", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("extracted_bytes", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("artifact_checksum", sa.String(length=64), nullable=False, server_default=""),
            sa.Column("detected_format", sa.String(length=40), nullable=False, server_default=""),
            sa.Column("detected_root", sa.String(length=1000), nullable=False, server_default=""),
            sa.Column("source_classes", sa.JSON(), nullable=False, server_default="[]"),
            sa.Column("class_mapping", sa.JSON(), nullable=False, server_default="{}"),
            sa.Column("quality_report", sa.JSON(), nullable=False, server_default="{}"),
            sa.Column("review_frame_ids", sa.JSON(), nullable=False, server_default="[]"),
            sa.Column("workflow_metadata", sa.JSON(), nullable=False, server_default="{}"),
            sa.Column("staging_path", sa.String(length=1000), nullable=False, server_default=""),
            sa.Column("fetch_task_id", sa.String(length=36), nullable=True),
            sa.Column("import_task_id", sa.String(length=36), nullable=True),
            sa.Column("dataset_version_id", sa.String(length=36), sa.ForeignKey("dataset_versions.id"), nullable=True),
            sa.Column("train_task_id", sa.String(length=36), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        )
        op.create_index("ix_public_dataset_imports_project_id", "public_dataset_imports", ["project_id"])
        op.create_index("ix_public_dataset_imports_state", "public_dataset_imports", ["state"])

    frame_columns = {column["name"] for column in inspector.get_columns("frames")}
    if "public_import_id" not in frame_columns:
        with op.batch_alter_table("frames") as batch:
            batch.add_column(sa.Column("public_import_id", sa.String(length=36), nullable=True))
            batch.create_foreign_key(
                "fk_frames_public_import_id", "public_dataset_imports", ["public_import_id"], ["id"], ondelete="SET NULL"
            )
            batch.create_index("ix_frames_public_import_id", ["public_import_id"])


def downgrade() -> None:
    pass
