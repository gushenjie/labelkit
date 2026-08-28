"""Add stable category display order."""

from alembic import op
import sqlalchemy as sa

revision = "0005_category_sort_order"
down_revision = "0004_project_execution_lease"
branch_labels = None
depends_on = None


def upgrade() -> None:
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("categories")}
    if "sort_order" not in columns:
        op.add_column("categories", sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"))


def downgrade() -> None:
    pass
