"""Unified persistence boundary for project material inventory and active scope."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from server.db.models import (
    Frame,
    FrameStatus,
    MaterialBatch,
    MaterialOrigin,
    ProjectExecutionLease,
    PublicDatasetImport,
    Task,
    TaskStatus,
    TaskType,
    Video,
)


PROCESSING_PUBLIC_STATES = {"created", "fetching", "publishing"}
ACTION_PUBLIC_STATES = {"fetched", "needs_label", "review", "review_expanded", "full_review_required"}
FAILED_PUBLIC_STATES = {"fetch_failed", "fetch_interrupted", "publish_interrupted"}
READY_PUBLIC_STATES = {
    "published",
    "training",
    "completed",
    "training_cancelled",
    "training_interrupted",
    "training_failed",
}


def active_frame_filter():
    """Single active-material predicate used by every current-pool frame query."""
    return or_(
        Frame.material_batch_id.is_(None),
        Frame.material_batch.has(MaterialBatch.archived_at.is_(None)),
    )


def active_video_filter():
    return or_(
        Video.material_batch_id.is_(None),
        Video.material_batch.has(MaterialBatch.archived_at.is_(None)),
    )


@dataclass(frozen=True)
class MaterialBatchDTO:
    id: str
    project_id: str
    origin: str
    title: str
    status: str
    frame_count: int
    usable_frame_count: int
    pending_frame_count: int
    frame_status_counts: dict[str, int]
    preview_frame_ids: tuple[str, ...]
    metadata: dict
    archived_at: datetime | None
    created_at: datetime
    updated_at: datetime
    next_action: str | None


@dataclass(frozen=True)
class MaterialInventorySummaryDTO:
    active_batch_count: int
    archived_batch_count: int
    usable_frame_count: int
    pending_batch_count: int
    intake_blocking_batch_count: int
    review_batch_count: int
    review_sample_count: int
    first_review_import_id: str | None
    counts_by_origin: dict[str, int]


@dataclass(frozen=True)
class MaterialInventoryDTO:
    summary: MaterialInventorySummaryDTO
    items: tuple[MaterialBatchDTO, ...]


@dataclass(frozen=True)
class MaterialFrameDTO:
    id: str
    filename: str
    status: str
    split: str
    created_at: datetime


@dataclass(frozen=True)
class MaterialFramePageDTO:
    items: tuple[MaterialFrameDTO, ...]
    total: int
    offset: int
    limit: int


@dataclass(frozen=True)
class MaterialBlockerDTO:
    batch_id: str
    title: str
    status: str
    next_action: str | None


class MaterialRepository:
    def __init__(self, db: Session):
        self._db = db

    @property
    def db(self) -> Session:
        return self._db

    def create_batch(
        self,
        *,
        project_id: str,
        origin: MaterialOrigin,
        title: str,
        metadata: dict | None = None,
    ) -> MaterialBatch:
        batch = MaterialBatch(
            project_id=project_id,
            origin=origin,
            title=title.strip() or "未命名素材",
            metadata_json=dict(metadata or {}),
        )
        self._db.add(batch)
        self._db.flush()
        return batch

    def get(self, project_id: str, batch_id: str) -> MaterialBatch | None:
        return (
            self._db.query(MaterialBatch)
            .filter(MaterialBatch.project_id == project_id, MaterialBatch.id == batch_id)
            .one_or_none()
        )

    def active_frames(self, project_id: str):
        return self._db.query(Frame).filter(Frame.project_id == project_id, active_frame_filter())

    def active_videos(self, project_id: str):
        return self._db.query(Video).filter(Video.project_id == project_id, active_video_filter())

    def _frame_counts(
        self, batch_ids: list[str]
    ) -> tuple[dict[str, int], dict[str, int], dict[str, int], dict[str, dict[str, int]]]:
        totals: dict[str, int] = defaultdict(int)
        usable: dict[str, int] = defaultdict(int)
        pending: dict[str, int] = defaultdict(int)
        status_counts: dict[str, dict[str, int]] = defaultdict(dict)
        if not batch_ids:
            return totals, usable, pending, status_counts
        rows = (
            self._db.query(Frame.material_batch_id, Frame.status, func.count(Frame.id))
            .filter(Frame.material_batch_id.in_(batch_ids))
            .group_by(Frame.material_batch_id, Frame.status)
            .all()
        )
        ready_statuses = {
            FrameStatus.AUTO_OK,
            FrameStatus.AUTO_FIXED,
            FrameStatus.HUMAN_OK,
            FrameStatus.NO_TARGET,
        }
        pending_statuses = {
            FrameStatus.UNLABELED,
            FrameStatus.LLM_LABELED,
            FrameStatus.NEEDS_HUMAN,
            FrameStatus.HUMAN_WRONG,
        }
        for batch_id, frame_status, count in rows:
            if not batch_id:
                continue
            totals[batch_id] += int(count)
            status_value = frame_status.value if hasattr(frame_status, "value") else str(frame_status)
            status_counts[batch_id][status_value] = int(count)
            if frame_status in ready_statuses:
                usable[batch_id] += int(count)
            if frame_status in pending_statuses:
                pending[batch_id] += int(count)
        return totals, usable, pending, status_counts

    def _previews(self, batch_ids: list[str]) -> dict[str, tuple[str, ...]]:
        if not batch_ids:
            return {}
        ranked = (
            self._db.query(
                Frame.id.label("frame_id"),
                Frame.material_batch_id.label("batch_id"),
                func.row_number()
                .over(partition_by=Frame.material_batch_id, order_by=(Frame.created_at.asc(), Frame.id.asc()))
                .label("rank"),
            )
            .filter(Frame.material_batch_id.in_(batch_ids))
            .subquery()
        )
        rows = self._db.query(ranked.c.batch_id, ranked.c.frame_id).filter(ranked.c.rank <= 6).all()
        previews: dict[str, list[str]] = defaultdict(list)
        for batch_id, frame_id in rows:
            previews[str(batch_id)].append(str(frame_id))
        return {key: tuple(value) for key, value in previews.items()}

    def _public_imports(self, batch_ids: list[str]) -> dict[str, PublicDatasetImport]:
        if not batch_ids:
            return {}
        return {
            item.material_batch_id: item
            for item in self._db.query(PublicDatasetImport)
            .filter(PublicDatasetImport.material_batch_id.in_(batch_ids))
            .all()
            if item.material_batch_id
        }

    def _videos(self, batch_ids: list[str]) -> dict[str, Video]:
        if not batch_ids:
            return {}
        return {
            item.material_batch_id: item
            for item in self._db.query(Video).filter(Video.material_batch_id.in_(batch_ids)).all()
            if item.material_batch_id
        }

    def _running_extract_video_ids(self, project_id: str) -> set[str]:
        tasks = (
            self._db.query(Task)
            .filter(
                Task.project_id == project_id,
                Task.task_type == TaskType.EXTRACT,
                Task.status.in_({TaskStatus.PENDING, TaskStatus.RUNNING}),
            )
            .all()
        )
        return {
            str(video_id)
            for task in tasks
            for video_id in (task.params or {}).get("video_ids", [])
        }

    def _batch_tasks(self, project_id: str, batch_ids: list[str]) -> dict[str, Task]:
        if not batch_ids:
            return {}
        tasks = (
            self._db.query(Task)
            .filter(
                Task.project_id == project_id,
                Task.task_type.in_({TaskType.IMPORT, TaskType.DERIVE_CLASSIFY}),
            )
            .order_by(Task.created_at.desc())
            .all()
        )
        result: dict[str, Task] = {}
        for task in tasks:
            batch_id = str((task.params or {}).get("material_batch_id") or "")
            if batch_id in batch_ids and batch_id not in result:
                result[batch_id] = task
        return result

    @staticmethod
    def _status_for(
        batch: MaterialBatch,
        *,
        frame_count: int,
        public_import: PublicDatasetImport | None,
        video: Video | None,
        batch_task: Task | None,
        running_extract_video_ids: set[str],
    ) -> tuple[str, str | None]:
        if batch.archived_at is not None:
            return "archived", "restore"
        if public_import:
            if public_import.state in PROCESSING_PUBLIC_STATES:
                return "processing", None
            if public_import.state in ACTION_PUBLIC_STATES:
                action = "review" if public_import.state.startswith("review") or public_import.state == "full_review_required" else "continue_import"
                if public_import.state == "needs_label":
                    action = "label"
                return "action_required", action
            if public_import.state in FAILED_PUBLIC_STATES:
                return "failed", "retry"
            if public_import.state == "discarded":
                return "archived", None
            if public_import.state in READY_PUBLIC_STATES:
                return "ready", "archive"
            return "action_required", "continue_import"
        if video:
            if video.id in running_extract_video_ids:
                return "processing", None
            if frame_count == 0:
                return "action_required", "extract"
            return "ready", "archive"
        if batch_task:
            if batch_task.status in {TaskStatus.PENDING, TaskStatus.RUNNING, TaskStatus.PAUSED}:
                return "processing", None
            if batch_task.status in {TaskStatus.FAILED, TaskStatus.CANCELLED, TaskStatus.INTERRUPTED}:
                return "failed", "retry"
        if frame_count == 0:
            return "failed", "archive"
        return "ready", "archive"

    def inventory(
        self,
        project_id: str,
        *,
        include_archived: bool = False,
        origin: str = "",
        status: str = "",
        query: str = "",
    ) -> MaterialInventoryDTO:
        all_batches = (
            self._db.query(MaterialBatch)
            .filter(MaterialBatch.project_id == project_id)
            .order_by(MaterialBatch.created_at.desc(), MaterialBatch.id.desc())
            .all()
        )
        ids = [batch.id for batch in all_batches]
        totals, usable, pending, status_counts = self._frame_counts(ids)
        previews = self._previews(ids)
        imports = self._public_imports(ids)
        videos = self._videos(ids)
        running_video_ids = self._running_extract_video_ids(project_id)
        batch_tasks = self._batch_tasks(project_id, ids)
        dtos: list[MaterialBatchDTO] = []
        for batch in all_batches:
            normalized_status, next_action = self._status_for(
                batch,
                frame_count=totals.get(batch.id, 0),
                public_import=imports.get(batch.id),
                video=videos.get(batch.id),
                batch_task=batch_tasks.get(batch.id),
                running_extract_video_ids=running_video_ids,
            )
            metadata = dict(batch.metadata_json or {})
            public_import = imports.get(batch.id)
            if public_import:
                metadata.update(
                    {
                        "public_import_id": public_import.id,
                        "provider": public_import.provider,
                        "source_ref": public_import.source_ref,
                        "source_version": public_import.source_version,
                        "source_url": public_import.source_url,
                        "license_name": public_import.license_name,
                        "public_state": public_import.state,
                        "review_sample_count": len(public_import.review_frame_ids or []),
                    }
                )
            video = videos.get(batch.id)
            if video:
                metadata.update(
                    {
                        "video_id": video.id,
                        "duration_sec": video.duration_sec,
                        "file_bytes": video.file_bytes,
                        "original_frame_count": video.frame_count,
                    }
                )
            dtos.append(
                MaterialBatchDTO(
                    id=batch.id,
                    project_id=batch.project_id,
                    origin=batch.origin.value if hasattr(batch.origin, "value") else str(batch.origin),
                    title=batch.title,
                    status=normalized_status,
                    frame_count=totals.get(batch.id, 0),
                    usable_frame_count=usable.get(batch.id, 0),
                    pending_frame_count=pending.get(batch.id, 0),
                    frame_status_counts=status_counts.get(batch.id, {}),
                    preview_frame_ids=previews.get(batch.id, ()),
                    metadata=metadata,
                    archived_at=batch.archived_at,
                    created_at=batch.created_at,
                    updated_at=batch.updated_at,
                    next_action=next_action,
                )
            )

        active = [item for item in dtos if item.status != "archived"]
        counts_by_origin: dict[str, int] = defaultdict(int)
        for item in active:
            counts_by_origin[item.origin] += 1
        intake_blockers = [
            item
            for item in active
            if item.status in {"processing", "failed"}
            or item.next_action in {"extract", "continue_import", "retry"}
        ]
        review_batches = [item for item in active if item.next_action == "review"]
        summary = MaterialInventorySummaryDTO(
            active_batch_count=len(active),
            archived_batch_count=len(dtos) - len(active),
            usable_frame_count=sum(item.frame_count for item in active),
            pending_batch_count=sum(item.status in {"processing", "action_required", "failed"} for item in active),
            intake_blocking_batch_count=len(intake_blockers),
            review_batch_count=len(review_batches),
            review_sample_count=sum(int(item.metadata.get("review_sample_count") or 0) for item in review_batches),
            first_review_import_id=(
                str(review_batches[0].metadata.get("public_import_id") or "") or None
                if review_batches
                else None
            ),
            counts_by_origin=dict(counts_by_origin),
        )

        filtered = dtos if include_archived else active
        if origin:
            filtered = [item for item in filtered if item.origin == origin]
        if status:
            filtered = [item for item in filtered if item.status == status]
        needle = query.strip().casefold()
        if needle:
            filtered = [item for item in filtered if needle in item.title.casefold()]
        return MaterialInventoryDTO(summary=summary, items=tuple(filtered))

    def frame_page(self, project_id: str, batch_id: str, *, offset: int, limit: int) -> MaterialFramePageDTO:
        batch = self.get(project_id, batch_id)
        if not batch:
            raise RuntimeError("素材批次不存在")
        query = self._db.query(Frame).filter(
            Frame.project_id == project_id,
            Frame.material_batch_id == batch_id,
        )
        total = query.count()
        rows = query.order_by(Frame.created_at.asc(), Frame.id.asc()).offset(offset).limit(limit).all()
        return MaterialFramePageDTO(
            items=tuple(
                MaterialFrameDTO(
                    id=frame.id,
                    filename=frame.filename,
                    status=frame.status.value,
                    split=frame.split,
                    created_at=frame.created_at,
                )
                for frame in rows
            ),
            total=total,
            offset=offset,
            limit=limit,
        )

    def blockers(self, project_id: str) -> tuple[MaterialBlockerDTO, ...]:
        inventory = self.inventory(project_id)
        return tuple(
            MaterialBlockerDTO(item.id, item.title, item.status, item.next_action)
            for item in inventory.items
            if item.status != "ready"
        )

    def archive(self, project_id: str, batch_id: str, *, lease_task_id: str | None = None) -> MaterialBatch:
        lease = self._db.get(ProjectExecutionLease, project_id)
        if lease and lease.task_id != lease_task_id:
            raise RuntimeError("项目存在运行中任务，请等待任务结束后再归档")
        batch = self.get(project_id, batch_id)
        if not batch:
            raise RuntimeError("素材批次不存在")
        if batch.archived_at is None:
            batch.archived_at = datetime.now(timezone.utc)
            self._db.flush()
        return batch

    def restore(self, project_id: str, batch_id: str, *, lease_task_id: str | None = None) -> MaterialBatch:
        lease = self._db.get(ProjectExecutionLease, project_id)
        if lease and lease.task_id != lease_task_id:
            raise RuntimeError("项目存在运行中任务，请等待任务结束后再恢复")
        batch = self.get(project_id, batch_id)
        if not batch:
            raise RuntimeError("素材批次不存在")
        discarded_import = (
            self._db.query(PublicDatasetImport.id)
            .filter(
                PublicDatasetImport.material_batch_id == batch_id,
                PublicDatasetImport.state == "discarded",
            )
            .first()
        )
        if discarded_import:
            raise RuntimeError("已放弃的公开导入不能恢复，请重新发起导入")
        paths = [path for (path,) in self._db.query(Frame.filepath).filter(Frame.material_batch_id == batch_id)]
        paths.extend(path for (path,) in self._db.query(Video.filepath).filter(Video.material_batch_id == batch_id))
        missing = next((path for path in paths if not Path(path).is_file()), None)
        if missing:
            raise RuntimeError(f"素材文件不存在，无法恢复：{Path(missing).name}")
        batch.archived_at = None
        self._db.flush()
        return batch
