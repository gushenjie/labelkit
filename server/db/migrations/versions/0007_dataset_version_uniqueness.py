"""Guarantee dataset version numbers are unique per project."""

from alembic import op
import sqlalchemy as sa

revision = "0007_dataset_version_uniqueness"
down_revision = "0006_public_dataset_imports"
branch_labels = None
depends_on = None


def upgrade() -> None:
    indexes = {index["name"] for index in sa.inspect(op.get_bind()).get_indexes("dataset_versions")}
    if "uq_dataset_versions_project_version" not in indexes:
        op.create_index(
            "uq_dataset_versions_project_version",
            "dataset_versions",
            ["project_id", "version"],
            unique=True,
        )


def downgrade() -> None:
    indexes = {index["name"] for index in sa.inspect(op.get_bind()).get_indexes("dataset_versions")}
    if "uq_dataset_versions_project_version" in indexes:
        op.drop_index("uq_dataset_versions_project_version", table_name="dataset_versions")
