"""Add project material batches and immutable dataset lineage."""

from __future__ import annotations

import uuid
from collections import defaultdict
from datetime import datetime, timezone

import sqlalchemy as sa
from alembic import op


revision = "0011_material_batches"
down_revision = "0010_users"
branch_labels = None
depends_on = None


_NAMESPACE = uuid.UUID("c8832925-b0f9-4e95-9f69-f27e3df7ea25")


def _batch_id(key: str) -> str:
    return str(uuid.uuid5(_NAMESPACE, key))


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _ensure_batch(
    bind,
    table,
    *,
    batch_id: str,
    project_id: str,
    origin: str,
    title: str,
    metadata: dict,
    created_at,
    archived_at=None,
) -> None:
    exists = bind.execute(
        sa.select(table.c.id).where(table.c.id == batch_id)
    ).scalar_one_or_none()
    if exists:
        return
    now = created_at or _utcnow()
    bind.execute(
        table.insert().values(
            id=batch_id,
            project_id=project_id,
            origin=origin,
            title=title or "历史素材",
            metadata=metadata,
            archived_at=archived_at,
            created_at=now,
            updated_at=now,
        )
    )


def _backfill() -> None:
    bind = op.get_bind()
    metadata = sa.MetaData()
    batches = sa.Table("material_batches", metadata, autoload_with=bind)
    videos = sa.Table("videos", metadata, autoload_with=bind)
    frames = sa.Table("frames", metadata, autoload_with=bind)
    imports = sa.Table("public_dataset_imports", metadata, autoload_with=bind)
    before_frames = int(bind.execute(sa.select(sa.func.count()).select_from(frames)).scalar_one())

    for row in bind.execute(
        sa.select(
            imports.c.id,
            imports.c.project_id,
            imports.c.title,
            imports.c.provider,
            imports.c.source_ref,
            imports.c.source_version,
            imports.c.license_name,
            imports.c.state,
            imports.c.created_at,
        )
    ).mappings():
        batch_id = _batch_id(f"public:{row['id']}")
        _ensure_batch(
            bind,
            batches,
            batch_id=batch_id,
            project_id=row["project_id"],
            origin="public_dataset",
            title=row["title"] or row["source_ref"] or "公开数据",
            metadata={
                "public_import_id": row["id"],
                "provider": row["provider"],
                "source_ref": row["source_ref"],
                "source_version": row["source_version"],
                "license_name": row["license_name"],
            },
            created_at=row["created_at"],
            archived_at=row["created_at"] if row["state"] == "discarded" else None,
        )
        bind.execute(imports.update().where(imports.c.id == row["id"]).values(material_batch_id=batch_id))
        bind.execute(
            frames.update()
            .where(frames.c.public_import_id == row["id"])
            .values(material_batch_id=batch_id)
        )

    for row in bind.execute(
        sa.select(
            videos.c.id,
            videos.c.project_id,
            videos.c.filename,
            videos.c.created_at,
        )
    ).mappings():
        batch_id = _batch_id(f"video:{row['id']}")
        _ensure_batch(
            bind,
            batches,
            batch_id=batch_id,
            project_id=row["project_id"],
            origin="video",
            title=row["filename"] or "历史视频",
            metadata={"video_id": row["id"]},
            created_at=row["created_at"],
        )
        bind.execute(videos.update().where(videos.c.id == row["id"]).values(material_batch_id=batch_id))
        bind.execute(
            frames.update()
            .where(frames.c.video_id == row["id"])
            .values(material_batch_id=batch_id)
        )

    remaining = bind.execute(
        sa.select(
            frames.c.id,
            frames.c.project_id,
            frames.c.source_group_id,
            frames.c.source,
            frames.c.filename,
            frames.c.created_at,
        ).where(frames.c.material_batch_id.is_(None))
    ).mappings()
    grouped: dict[tuple[str, str], list] = defaultdict(list)
    for row in remaining:
        group_key = row["source_group_id"] or "ungrouped"
        grouped[(row["project_id"], group_key)].append(row)

    origin_map = {"upload": "image_upload", "import": "dataset_import", "derive": "derived"}
    title_map = {
        "image_upload": "历史图片上传",
        "dataset_import": "历史数据集导入",
        "derived": "历史派生素材",
        "legacy": "历史素材",
    }
    for (project_id, group_key), rows in grouped.items():
        stable_sources = {str(row["source"] or "") for row in rows}
        origin = origin_map.get(next(iter(stable_sources))) if len(stable_sources) == 1 else None
        origin = origin or "legacy"
        batch_id = _batch_id(f"frame-group:{project_id}:{group_key}")
        first = min(rows, key=lambda row: row["created_at"] or _utcnow())
        _ensure_batch(
            bind,
            batches,
            batch_id=batch_id,
            project_id=project_id,
            origin=origin,
            title=title_map[origin],
            metadata={"source_group_id": None if group_key == "ungrouped" else group_key},
            created_at=first["created_at"],
        )
        bind.execute(
            frames.update()
            .where(frames.c.id.in_([row["id"] for row in rows]))
            .values(material_batch_id=batch_id)
        )

    after_frames = int(bind.execute(sa.select(sa.func.count()).select_from(frames)).scalar_one())
    linked_frames = int(
        bind.execute(
            sa.select(sa.func.count()).select_from(frames).where(frames.c.material_batch_id.is_not(None))
        ).scalar_one()
    )
    legacy_batches = int(
        bind.execute(
            sa.select(sa.func.count()).select_from(batches).where(batches.c.origin == "legacy")
        ).scalar_one()
    )
    orphan_frames = int(
        bind.execute(
            sa.select(sa.func.count())
            .select_from(frames.outerjoin(batches, frames.c.material_batch_id == batches.c.id))
            .where(frames.c.material_batch_id.is_not(None), batches.c.id.is_(None))
        ).scalar_one()
    )
    print(
        "material batch backfill: "
        f"frames_before={before_frames}, frames_after={after_frames}, "
        f"linked={linked_frames}, legacy_batches={legacy_batches}, orphans={orphan_frames}"
    )
    if before_frames != after_frames or orphan_frames:
        raise RuntimeError("素材批次历史回填对账失败，已停止迁移")


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    tables = set(inspector.get_table_names())
    if "material_batches" not in tables:
        op.create_table(
            "material_batches",
            sa.Column("id", sa.String(length=36), primary_key=True),
            sa.Column("project_id", sa.String(length=36), sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
            sa.Column("origin", sa.String(length=40), nullable=False),
            sa.Column("title", sa.String(length=500), nullable=False),
            sa.Column("metadata", sa.JSON(), nullable=False, server_default="{}"),
            sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        )
        op.create_index("ix_material_batches_project_id", "material_batches", ["project_id"])
        op.create_index("ix_material_batches_archived_at", "material_batches", ["archived_at"])

    inspector = sa.inspect(op.get_bind())
    for table_name in ("videos", "frames", "public_dataset_imports"):
        columns = {column["name"] for column in inspector.get_columns(table_name)}
        if "material_batch_id" not in columns:
            with op.batch_alter_table(table_name) as batch:
                batch.add_column(sa.Column("material_batch_id", sa.String(length=36), nullable=True))
                batch.create_foreign_key(
                    f"fk_{table_name}_material_batch_id",
                    "material_batches",
                    ["material_batch_id"],
                    ["id"],
                    ondelete="SET NULL",
                )
                batch.create_index(f"ix_{table_name}_material_batch_id", ["material_batch_id"])

    inspector = sa.inspect(op.get_bind())
    if "dataset_version_material_batches" not in set(inspector.get_table_names()):
        op.create_table(
            "dataset_version_material_batches",
            sa.Column("dataset_version_id", sa.String(length=36), sa.ForeignKey("dataset_versions.id", ondelete="CASCADE"), primary_key=True),
            sa.Column("material_batch_id", sa.String(length=36), sa.ForeignKey("material_batches.id", ondelete="RESTRICT"), primary_key=True),
            sa.Column("origin", sa.String(length=40), nullable=False),
            sa.Column("title", sa.String(length=500), nullable=False),
            sa.Column("metadata", sa.JSON(), nullable=False, server_default="{}"),
            sa.Column("frame_count", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("content_checksum", sa.String(length=64), nullable=False, server_default=""),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        )
        op.create_index(
            "ix_dataset_version_material_batches_batch_id",
            "dataset_version_material_batches",
            ["material_batch_id"],
        )

    _backfill()


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if "dataset_version_material_batches" in set(inspector.get_table_names()):
        indexes = {item["name"] for item in inspector.get_indexes("dataset_version_material_batches")}
        if "ix_dataset_version_material_batches_batch_id" in indexes:
            op.drop_index(
                "ix_dataset_version_material_batches_batch_id",
                table_name="dataset_version_material_batches",
            )
        op.drop_table("dataset_version_material_batches")

    inspector = sa.inspect(op.get_bind())
    for table_name in ("public_dataset_imports", "frames", "videos"):
        columns = {column["name"] for column in inspector.get_columns(table_name)}
        if "material_batch_id" in columns:
            with op.batch_alter_table(table_name) as batch:
                batch.drop_index(f"ix_{table_name}_material_batch_id")
                batch.drop_constraint(f"fk_{table_name}_material_batch_id", type_="foreignkey")
                batch.drop_column("material_batch_id")

    inspector = sa.inspect(op.get_bind())
    if "material_batches" in set(inspector.get_table_names()):
        op.drop_index("ix_material_batches_archived_at", table_name="material_batches")
        op.drop_index("ix_material_batches_project_id", table_name="material_batches")
        op.drop_table("material_batches")
