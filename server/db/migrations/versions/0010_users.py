"""新增用户表与项目创建人字段。"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0010_users"
down_revision = "0009_audit_logs"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    tables = set(inspector.get_table_names())

    if "users" not in tables:
        op.create_table(
            "users",
            sa.Column("id", sa.String(length=36), primary_key=True),
            sa.Column("username", sa.String(length=64), nullable=False),
            sa.Column("display_name", sa.String(length=100), nullable=False),
            sa.Column("password_hash", sa.String(length=255), nullable=False),
            sa.Column(
                "role",
                sa.Enum("admin", "annotator", "reviewer", "viewer", name="userrole"),
                nullable=False,
                server_default="viewer",
            ),
            sa.Column(
                "status",
                sa.Enum("active", "disabled", name="userstatus"),
                nullable=False,
                server_default="active",
            ),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("last_login_at", sa.DateTime(timezone=True), nullable=True),
        )
        op.create_index("ix_users_username", "users", ["username"], unique=True)

    project_columns = {column["name"] for column in inspector.get_columns("projects")}
    if "created_by" not in project_columns:
        op.add_column(
            "projects",
            sa.Column("created_by", sa.String(length=100), nullable=False, server_default="工作区管理员"),
        )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    project_columns = {column["name"] for column in inspector.get_columns("projects")}
    if "created_by" in project_columns:
        op.drop_column("projects", "created_by")

    tables = set(inspector.get_table_names())
    if "users" in tables:
        op.drop_index("ix_users_username", table_name="users")
        op.drop_table("users")
