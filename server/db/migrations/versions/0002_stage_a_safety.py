"""Add collision-safe media and task-control fields."""

from alembic import op
import sqlalchemy as sa

revision = "0002_stage_a_safety"
down_revision = "0001_baseline"
branch_labels = None
depends_on = None


def _column_names(table: str) -> set[str]:
    return {column["name"] for column in sa.inspect(op.get_bind()).get_columns(table)}


def _index_names(table: str) -> set[str]:
    return {index["name"] for index in sa.inspect(op.get_bind()).get_indexes(table)}


def upgrade() -> None:
    video_columns = _column_names("videos")
    if "storage_key" not in video_columns:
        op.add_column("videos", sa.Column("storage_key", sa.String(length=100), nullable=True))
    if "ix_videos_storage_key" not in _index_names("videos"):
        op.create_index("ix_videos_storage_key", "videos", ["storage_key"], unique=True)

    frame_columns = _column_names("frames")
    if "storage_key" not in frame_columns:
        op.add_column("frames", sa.Column("storage_key", sa.String(length=100), nullable=True))
    if "source_group_id" not in frame_columns:
        op.add_column("frames", sa.Column("source_group_id", sa.String(length=100), nullable=True))
    frame_indexes = _index_names("frames")
    if "ix_frames_storage_key" not in frame_indexes:
        op.create_index("ix_frames_storage_key", "frames", ["storage_key"], unique=True)
    if "ix_frames_source_group_id" not in frame_indexes:
        op.create_index("ix_frames_source_group_id", "frames", ["source_group_id"], unique=False)

    task_columns = _column_names("tasks")
    if "cancel_requested" not in task_columns:
        op.add_column("tasks", sa.Column("cancel_requested", sa.Boolean(), nullable=False, server_default=sa.false()))
    if "heartbeat_at" not in task_columns:
        op.add_column("tasks", sa.Column("heartbeat_at", sa.DateTime(timezone=True), nullable=True))
    if "retry_of_task_id" not in task_columns:
        op.add_column("tasks", sa.Column("retry_of_task_id", sa.String(length=36), nullable=True))


def downgrade() -> None:
    pass
