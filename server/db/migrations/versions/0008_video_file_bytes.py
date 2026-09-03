"""Persist uploaded video file size for list display."""

from __future__ import annotations

from pathlib import Path

import sqlalchemy as sa
from alembic import op

revision = "0008_video_file_bytes"
down_revision = "0007_dataset_version_uniqueness"
branch_labels = None
depends_on = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    columns = {column["name"] for column in inspector.get_columns("videos")}
    if "file_bytes" not in columns:
        op.add_column("videos", sa.Column("file_bytes", sa.Integer(), nullable=True))

    connection = op.get_bind()
    rows = connection.execute(sa.text("SELECT id, filepath FROM videos WHERE file_bytes IS NULL")).fetchall()
    for row in rows:
        path = Path(row.filepath)
        if not path.is_file():
            continue
        connection.execute(
            sa.text("UPDATE videos SET file_bytes = :size WHERE id = :id"),
            {"size": path.stat().st_size, "id": row.id},
        )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    columns = {column["name"] for column in inspector.get_columns("videos")}
    if "file_bytes" in columns:
        op.drop_column("videos", "file_bytes")
