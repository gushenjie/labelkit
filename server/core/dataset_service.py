"""Immutable dataset snapshots and source-group-safe splitting."""

from __future__ import annotations

import hashlib
import json
import shutil
import os
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from sqlalchemy import func
from sqlalchemy.orm import Session, selectinload

from server.core.paths import dataset_versions_dir
from server.db.models import (
    Category,
    DatasetVersion,
    DatasetVersionMaterialBatch,
    Frame,
    FrameStatus,
    MaterialBatch,
    ModelVersion,
    Project,
    ProjectTaskType,
    PublicDatasetImport,
    Task,
)
from server.repositories.material_repository import MaterialRepository, active_frame_filter
from server.services.material_readiness_service import MaterialReadinessService

TRAINABLE = {
    FrameStatus.AUTO_OK,
    FrameStatus.AUTO_FIXED,
    FrameStatus.HUMAN_OK,
    FrameStatus.NO_TARGET,
}


@dataclass(frozen=True)
class SnapshotFrameInput:
    id: str
    filepath: Path
    filename: str
    storage_key: str | None
    source_group_id: str
    status: str
    material_batch_id: str | None
    ingest_origin: str
    locked_split: str | None
    labels: tuple[tuple[int, float | None, float | None, float | None, float | None], ...]


@dataclass(frozen=True)
class DatasetVersionDTO:
    id: str
    project_id: str
    version: int
    checksum: str
    categories: tuple[dict, ...]
    manifest: dict
    snapshot_path: Path


@dataclass(frozen=True)
class DatasetModelRefDTO:
    id: str
    name: str
    version: int
    created_at: datetime


@dataclass(frozen=True)
class DatasetTaskRefDTO:
    id: str
    task_type: str
    status: str
    created_at: datetime


@dataclass(frozen=True)
class DatasetSourceRefDTO:
    provider: str
    title: str
    source_url: str


@dataclass(frozen=True)
class DatasetVersionSummaryDTO:
    id: str
    project_id: str
    project_name: str
    version: int
    status: str
    task_type: str
    checksum: str
    sample_count: int
    train_count: int
    val_count: int
    test_count: int
    class_count: int
    source_group_count: int
    linked_model_count: int
    created_at: datetime


@dataclass(frozen=True)
class DatasetCatalogDTO:
    total_versions: int
    project_count: int
    snapshot_sample_count: int
    linked_model_count: int
    total: int
    items: tuple[DatasetVersionSummaryDTO, ...]


@dataclass(frozen=True)
class DatasetVersionDetailDTO:
    summary: DatasetVersionSummaryDTO
    categories: tuple[dict, ...]
    status_counts: dict[str, int]
    linked_models: tuple[DatasetModelRefDTO, ...]
    linked_tasks: tuple[DatasetTaskRefDTO, ...]
    trigger_sources: tuple[DatasetSourceRefDTO, ...]


class DatasetVersionRepository:
    def __init__(self, db: Session):
        self._db = db

    @property
    def db(self) -> Session:
        return self._db

    def list_frames(self, project_id: str, task_type: ProjectTaskType) -> list[SnapshotFrameInput]:
        frames = (
            self._db.query(Frame)
            .options(selectinload(Frame.annotations), selectinload(Frame.material_batch))
            .filter(Frame.project_id == project_id, Frame.status.in_(TRAINABLE), active_frame_filter())
            .order_by(Frame.id)
            .all()
        )
        result: list[SnapshotFrameInput] = []
        for frame in frames:
            if task_type == ProjectTaskType.CLASSIFY and (
                frame.status == FrameStatus.NO_TARGET or not frame.annotations
            ):
                continue
            labels = tuple(
                (
                    annotation.class_id,
                    annotation.x_center,
                    annotation.y_center,
                    annotation.width,
                    annotation.height,
                )
                for annotation in sorted(frame.annotations, key=lambda item: item.id)
            )
            result.append(
                SnapshotFrameInput(
                    id=frame.id,
                    filepath=Path(frame.filepath),
                    filename=frame.filename,
                    storage_key=frame.storage_key,
                    source_group_id=frame.source_group_id or frame.video_id or frame.id,
                    status=frame.status.value,
                    material_batch_id=frame.material_batch_id,
                    ingest_origin=(
                        frame.material_batch.origin.value
                        if frame.material_batch and hasattr(frame.material_batch.origin, "value")
                        else str(frame.material_batch.origin)
                        if frame.material_batch
                        else "legacy"
                    ),
                    locked_split=(
                        frame.split
                        if frame.public_import_id
                        and ":locked:" in (frame.source_group_id or "")
                        and frame.split in {"train", "val", "test"}
                        else None
                    ),
                    labels=labels,
                )
            )
        return result

    def list_categories(self, project_id: str) -> tuple[dict, ...]:
        categories = (
            self._db.query(Category)
            .filter(Category.project_id == project_id)
            .order_by(Category.class_id)
            .all()
        )
        return tuple(
            {
                "class_id": category.class_id,
                "name": category.name,
                "description": category.description,
            }
            for category in categories
        )

    def next_version(self, project_id: str) -> int:
        latest = self._db.query(func.max(DatasetVersion.version)).filter(
            DatasetVersion.project_id == project_id
        ).scalar()
        return int(latest or 0) + 1

    def save(self, version: DatasetVersionDTO) -> None:
        self._db.add(
            DatasetVersion(
                id=version.id,
                project_id=version.project_id,
                version=version.version,
                status="ready",
                checksum=version.checksum,
                categories=list(version.categories),
                manifest=version.manifest,
                snapshot_path=str(version.snapshot_path),
            )
        )
        self._db.flush()

    def save_material_batch_links(self, version_id: str, entries: list[dict]) -> None:
        grouped: dict[str, list[dict]] = {}
        for entry in entries:
            batch_id = entry.get("material_batch_id")
            if batch_id:
                grouped.setdefault(str(batch_id), []).append(entry)
        if not grouped:
            return
        batches = {
            batch.id: batch
            for batch in self._db.query(MaterialBatch).filter(MaterialBatch.id.in_(grouped)).all()
        }
        for batch_id, batch_entries in grouped.items():
            batch = batches.get(batch_id)
            if not batch:
                raise RuntimeError(f"素材批次不存在: {batch_id}")
            content_payload = [
                {
                    "frame_id": item["frame_id"],
                    "image_checksum": item["image_checksum"],
                    "label_checksum": item["label_checksum"],
                }
                for item in sorted(batch_entries, key=lambda item: item["frame_id"])
            ]
            content_checksum = hashlib.sha256(
                json.dumps(content_payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
            ).hexdigest()
            self._db.add(
                DatasetVersionMaterialBatch(
                    dataset_version_id=version_id,
                    material_batch_id=batch_id,
                    origin=batch.origin.value if hasattr(batch.origin, "value") else str(batch.origin),
                    title=batch.title,
                    metadata_json=dict(batch.metadata_json or {}),
                    frame_count=len(batch_entries),
                    content_checksum=content_checksum,
                )
            )
        self._db.flush()

    def get(self, version_id: str, project_id: str) -> DatasetVersionDTO | None:
        model = self._db.get(DatasetVersion, version_id)
        if not model or model.project_id != project_id or model.status != "ready":
            return None
        return DatasetVersionDTO(
            id=model.id,
            project_id=model.project_id,
            version=model.version,
            checksum=model.checksum,
            categories=tuple(model.categories),
            manifest=model.manifest,
            snapshot_path=Path(model.snapshot_path),
        )

    def list_records(self) -> list[tuple[DatasetVersion, str]]:
        return (
            self._db.query(DatasetVersion, Project.name)
            .join(Project, Project.id == DatasetVersion.project_id)
            .order_by(DatasetVersion.created_at.desc())
            .all()
        )

    def get_record(self, project_id: str, version_id: str) -> tuple[DatasetVersion, str] | None:
        return (
            self._db.query(DatasetVersion, Project.name)
            .join(Project, Project.id == DatasetVersion.project_id)
            .filter(DatasetVersion.project_id == project_id, DatasetVersion.id == version_id)
            .first()
        )

    def model_counts(self) -> dict[str, int]:
        return {
            version_id: int(count)
            for version_id, count in self._db.query(
                ModelVersion.dataset_version_id,
                func.count(ModelVersion.id),
            )
            .filter(ModelVersion.dataset_version_id.is_not(None))
            .group_by(ModelVersion.dataset_version_id)
            .all()
        }

    def linked_models(self, version_id: str) -> tuple[DatasetModelRefDTO, ...]:
        models = (
            self._db.query(ModelVersion)
            .filter(ModelVersion.dataset_version_id == version_id)
            .order_by(ModelVersion.created_at.desc())
            .all()
        )
        return tuple(
            DatasetModelRefDTO(model.id, model.name, model.version, model.created_at)
            for model in models
        )

    def linked_tasks(self, project_id: str, version_id: str) -> tuple[DatasetTaskRefDTO, ...]:
        tasks = self._db.query(Task).filter(Task.project_id == project_id).order_by(Task.created_at.desc()).all()
        return tuple(
            DatasetTaskRefDTO(task.id, task.task_type.value, task.status.value, task.created_at)
            for task in tasks
            if str((task.result or {}).get("dataset_version_id") or "") == version_id
            or str((task.params or {}).get("dataset_version_id") or "") == version_id
        )

    def trigger_sources(self, project_id: str, version_id: str) -> tuple[DatasetSourceRefDTO, ...]:
        links = (
            self._db.query(DatasetVersionMaterialBatch)
            .filter(DatasetVersionMaterialBatch.dataset_version_id == version_id)
            .order_by(DatasetVersionMaterialBatch.created_at, DatasetVersionMaterialBatch.material_batch_id)
            .all()
        )
        if links:
            return tuple(
                DatasetSourceRefDTO(
                    str((item.metadata_json or {}).get("provider") or item.origin),
                    item.title,
                    str((item.metadata_json or {}).get("source_url") or ""),
                )
                for item in links
            )
        imports = (
            self._db.query(PublicDatasetImport)
            .filter(
                PublicDatasetImport.project_id == project_id,
                PublicDatasetImport.dataset_version_id == version_id,
            )
            .order_by(PublicDatasetImport.created_at.desc())
            .all()
        )
        return tuple(
            DatasetSourceRefDTO(item.provider, item.title or item.source_ref, item.source_url)
            for item in imports
        )


def _frame_level_split(frames: list[SnapshotFrameInput], val_ratio: float) -> dict[str, str]:
    """单来源或 POC 小数据集：按帧划分 train/val（相邻帧可能相似，仅适合试运行）。"""
    ordered = sorted(frames, key=lambda frame: frame.id)
    count = len(ordered)
    if count < 2:
        raise RuntimeError("可训练样本不足：至少需要 2 张图片才能划分训练集与验证集")
    ratio = max(0.05, min(0.5, val_ratio))
    val_count = max(1, round(count * ratio))
    val_count = min(val_count, count - 1)
    step = count / val_count
    val_ids = {ordered[int(i * step)].id for i in range(val_count)}
    return {frame.id: ("val" if frame.id in val_ids else "train") for frame in ordered}


def _grouped_split(frames: list[SnapshotFrameInput], val_ratio: float) -> dict[str, str]:
    groups: dict[str, list[SnapshotFrameInput]] = {}
    for frame in frames:
        groups.setdefault(frame.source_group_id, []).append(frame)
    if len(groups) < 2:
        if len(frames) >= 2:
            return _frame_level_split(frames, val_ratio)
        raise RuntimeError(
            "可训练样本不足：至少需要 2 张图片才能划分训练集与验证集。"
            "多段视频/分批上传图片可获得更可靠的验证划分。"
        )
    target = max(1, round(len(frames) * max(0.05, min(0.5, val_ratio))))
    ordered = sorted(groups, key=lambda group: hashlib.sha256(group.encode("utf-8")).hexdigest())
    val_groups: set[str] = set()
    val_count = 0
    for group in ordered:
        if val_count >= target and val_groups:
            break
        if len(val_groups) == len(groups) - 1:
            break
        val_groups.add(group)
        val_count += len(groups[group])
    return {
        frame.id: ("val" if frame.source_group_id in val_groups else "train")
        for frame in frames
    }


def _classify_grouped_split(frames: list[SnapshotFrameInput]) -> dict[str, str]:
    group_classes: dict[str, set[int]] = {}
    class_groups: dict[int, set[str]] = {}
    for frame in frames:
        class_id = frame.labels[0][0]
        group_classes.setdefault(frame.source_group_id, set()).add(class_id)
        class_groups.setdefault(class_id, set()).add(frame.source_group_id)
    insufficient = {class_id: groups for class_id, groups in class_groups.items() if len(groups) < 2}
    if insufficient:
        detail = ", ".join(f"class {class_id}: {len(groups)} 个来源组" for class_id, groups in sorted(insufficient.items()))
        raise RuntimeError(f"分类类别无法同时覆盖 train/val；每类至少需要 2 个来源组（{detail}）")

    val_groups: set[str] = set()
    for class_id in sorted(class_groups):
        if class_groups[class_id] & val_groups:
            continue
        candidates = []
        for group in class_groups[class_id] - val_groups:
            proposed = val_groups | {group}
            if all(groups - proposed for groups in class_groups.values()):
                candidates.append(group)
        if not candidates:
            raise RuntimeError(f"无法在不清空训练类别的前提下为 class {class_id} 分配验证来源组")
        val_groups.add(min(candidates, key=lambda value: hashlib.sha256(value.encode()).hexdigest()))

    split_map = {
        frame.id: ("val" if frame.source_group_id in val_groups else "train")
        for frame in frames
    }
    for class_id in class_groups:
        splits = {split_map[frame.id] for frame in frames if frame.labels[0][0] == class_id}
        if splits != {"train", "val"}:
            raise RuntimeError(f"class {class_id} 未能同时进入 train/val")
    return split_map


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _link_or_copy_immutable(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.link(source, destination)
    except OSError:
        shutil.copy2(source, destination)


class DatasetService:
    def __init__(self, repository: DatasetVersionRepository):
        self._repository = repository

    def create_version(
        self,
        project_id: str,
        task_type: ProjectTaskType,
        *,
        val_ratio: float = 0.2,
    ) -> DatasetVersionDTO:
        MaterialReadinessService(MaterialRepository(self._repository.db)).assert_current_pool_ready(project_id)
        frames = self._repository.list_frames(project_id, task_type)
        if not frames:
            raise RuntimeError("没有可创建数据版本的已确认样本")
        categories = self._repository.list_categories(project_id)
        locked = {frame.id: frame.locked_split for frame in frames if frame.locked_split}
        unlocked = [frame for frame in frames if not frame.locked_split]
        split_map: dict[str, str] = {key: value for key, value in locked.items() if value is not None}
        if unlocked:
            try:
                generated = (
                    _classify_grouped_split(unlocked)
                    if task_type == ProjectTaskType.CLASSIFY
                    else _grouped_split(unlocked, val_ratio)
                )
            except RuntimeError:
                if not ({"train", "val"} <= set(locked.values())):
                    raise
                generated = {frame.id: "train" for frame in unlocked}
            split_map.update(generated)
        train_val = {value for value in split_map.values() if value in {"train", "val"}}
        if train_val != {"train", "val"}:
            raise RuntimeError("数据版本必须同时包含 train 和 val")
        if task_type == ProjectTaskType.CLASSIFY:
            by_class: dict[int, set[str]] = {}
            for frame in frames:
                if not frame.labels:
                    continue
                by_class.setdefault(frame.labels[0][0], set()).add(split_map[frame.id])
            missing = [class_id for class_id, splits in by_class.items() if not {"train", "val"} <= splits]
            if missing:
                raise RuntimeError(f"分类类别无法同时覆盖 train/val: {sorted(missing)}")
        version_id = str(uuid.uuid4())
        version_number = self._repository.next_version(project_id)
        root = dataset_versions_dir(project_id) / f"v{version_number}-{version_id}"
        staging = root.with_name(f".{root.name}.staging")
        if staging.exists():
            shutil.rmtree(staging)
        staging.mkdir(parents=True)
        entries: list[dict] = []
        try:
            for frame in frames:
                if not frame.filepath.is_file():
                    raise RuntimeError(f"版本化失败，图片不存在: {frame.filepath}")
                suffix = frame.filepath.suffix.lower() or ".jpg"
                relative_image = Path("media") / f"{frame.id}{suffix}"
                snapshot_image = staging / relative_image
                _link_or_copy_immutable(frame.filepath, snapshot_image)
                labels = [list(label) for label in frame.labels]
                label_payload = json.dumps(labels, separators=(",", ":"), ensure_ascii=False)
                entries.append(
                    {
                        "frame_id": frame.id,
                        "filename": frame.filename,
                        "storage_key": frame.storage_key,
                        "source_group_id": frame.source_group_id,
                        "status": frame.status,
                        "material_batch_id": frame.material_batch_id,
                        "ingest_origin": frame.ingest_origin,
                        "split": split_map[frame.id],
                        "image": relative_image.as_posix(),
                        "image_checksum": _sha256_file(snapshot_image),
                        "labels": labels,
                        "label_checksum": hashlib.sha256(label_payload.encode("utf-8")).hexdigest(),
                    }
                )
            manifest = {
                "schema_version": 2,
                "task_type": task_type.value,
                "frames": entries,
            }
            checksum_payload = json.dumps(
                {"categories": categories, "manifest": manifest},
                sort_keys=True,
                separators=(",", ":"),
                ensure_ascii=False,
            )
            checksum = hashlib.sha256(checksum_payload.encode("utf-8")).hexdigest()
            (staging / "manifest.json").write_text(checksum_payload, encoding="utf-8")
            staging.replace(root)
        except Exception:
            if staging.exists():
                shutil.rmtree(staging)
            raise

        version = DatasetVersionDTO(
            id=version_id,
            project_id=project_id,
            version=version_number,
            checksum=checksum,
            categories=categories,
            manifest=manifest,
            snapshot_path=root,
        )
        try:
            self._repository.save(version)
            self._repository.save_material_batch_links(version.id, entries)
        except Exception:
            if root.exists():
                shutil.rmtree(root)
            raise
        return version

    def get_version(self, project_id: str, version_id: str) -> DatasetVersionDTO:
        version = self._repository.get(version_id, project_id)
        if not version:
            raise RuntimeError(f"Dataset version not found: {version_id}")
        return version

    def resolve_train_cover(self, version: DatasetVersionDTO) -> Path:
        """返回训练集首张快照图片路径（无 train 时回退任意首帧）。"""
        frames = list(version.manifest.get("frames") or [])
        train_frames = [entry for entry in frames if str(entry.get("split") or "") == "train"]
        entry = (train_frames or frames)[0] if (train_frames or frames) else None
        if entry is None:
            raise RuntimeError("数据版本没有可用预览图")
        relative = str(entry.get("image") or "").strip()
        if not relative:
            raise RuntimeError("数据版本预览图路径缺失")
        path = (version.snapshot_path / relative).resolve()
        root = version.snapshot_path.resolve()
        if root not in path.parents and path != root:
            raise RuntimeError("数据版本预览图路径非法")
        if not path.is_file():
            raise RuntimeError("数据版本预览图文件不存在")
        return path

    @staticmethod
    def _summary(
        model: DatasetVersion,
        project_name: str,
        linked_model_count: int,
    ) -> DatasetVersionSummaryDTO:
        manifest = model.manifest or {}
        frames = manifest.get("frames") or []
        split_counts = {"train": 0, "val": 0, "test": 0}
        source_groups: set[str] = set()
        for entry in frames:
            split = str(entry.get("split") or "")
            if split in split_counts:
                split_counts[split] += 1
            source_group = str(entry.get("source_group_id") or "")
            if source_group:
                source_groups.add(source_group)
        return DatasetVersionSummaryDTO(
            id=model.id,
            project_id=model.project_id,
            project_name=project_name,
            version=model.version,
            status=model.status,
            task_type=str(manifest.get("task_type") or "detect"),
            checksum=model.checksum,
            sample_count=len(frames),
            train_count=split_counts["train"],
            val_count=split_counts["val"],
            test_count=split_counts["test"],
            class_count=len(model.categories or []),
            source_group_count=len(source_groups),
            linked_model_count=linked_model_count,
            created_at=model.created_at,
        )

    def catalog(
        self,
        *,
        project_id: str = "",
        query: str = "",
        task_type: str = "",
        offset: int = 0,
        limit: int = 100,
    ) -> DatasetCatalogDTO:
        model_counts = self._repository.model_counts()
        summaries = [
            self._summary(model, project_name, model_counts.get(model.id, 0))
            for model, project_name in self._repository.list_records()
        ]
        normalized_query = query.strip().lower()
        filtered = [
            item
            for item in summaries
            if (not project_id or item.project_id == project_id)
            and (not task_type or item.task_type == task_type)
            and (
                not normalized_query
                or normalized_query in item.project_name.lower()
                or normalized_query in f"v{item.version}"
                or normalized_query in item.id.lower()
            )
        ]
        page = tuple(filtered[max(0, offset):max(0, offset) + max(1, min(limit, 200))])
        return DatasetCatalogDTO(
            total_versions=len(summaries),
            project_count=len({item.project_id for item in summaries}),
            snapshot_sample_count=sum(item.sample_count for item in summaries),
            linked_model_count=sum(item.linked_model_count for item in summaries),
            total=len(filtered),
            items=page,
        )

    def detail(self, project_id: str, version_id: str) -> DatasetVersionDetailDTO:
        record = self._repository.get_record(project_id, version_id)
        if not record:
            raise RuntimeError(f"Dataset version not found: {version_id}")
        model, project_name = record
        linked_models = self._repository.linked_models(version_id)
        summary = self._summary(model, project_name, len(linked_models))
        status_counts: dict[str, int] = {}
        for entry in (model.manifest or {}).get("frames") or []:
            status = str(entry.get("status") or "unknown")
            status_counts[status] = status_counts.get(status, 0) + 1
        return DatasetVersionDetailDTO(
            summary=summary,
            categories=tuple(model.categories or []),
            status_counts=status_counts,
            linked_models=linked_models,
            linked_tasks=self._repository.linked_tasks(project_id, version_id),
            trigger_sources=self._repository.trigger_sources(project_id, version_id),
        )

    def materialize(
        self,
        version: DatasetVersionDTO,
        out_dir: Path,
        *,
        cancelled: Callable[[], bool] | None = None,
    ) -> dict:
        stats = {"train": 0, "val": 0, "test": 0, "total": 0}
        task_type = version.manifest["task_type"]
        category_names = {item["class_id"]: item["name"] for item in version.categories}
        for entry in version.manifest["frames"]:
            if cancelled and cancelled():
                raise RuntimeError("任务已取消")
            source = version.snapshot_path / entry["image"]
            if _sha256_file(source) != entry["image_checksum"]:
                raise RuntimeError(f"Dataset version image checksum mismatch: {entry['frame_id']}")
            label_payload = json.dumps(entry["labels"], separators=(",", ":"), ensure_ascii=False)
            if hashlib.sha256(label_payload.encode("utf-8")).hexdigest() != entry["label_checksum"]:
                raise RuntimeError(f"Dataset version label checksum mismatch: {entry['frame_id']}")
            split = entry["split"]
            suffix = source.suffix.lower()
            if task_type == ProjectTaskType.CLASSIFY.value:
                class_id = int(entry["labels"][0][0])
                class_name = category_names.get(class_id, str(class_id))
                if Path(class_name).name != class_name or class_name in {".", ".."}:
                    raise RuntimeError(f"Unsafe category name: {class_name}")
                destination = out_dir / split / class_name / f"{entry['frame_id']}{suffix}"
            else:
                destination = out_dir / "images" / split / f"{entry['frame_id']}{suffix}"
                label_path = out_dir / "labels" / split / f"{entry['frame_id']}.txt"
                label_path.parent.mkdir(parents=True, exist_ok=True)
                lines = [
                    f"{int(label[0])} {float(label[1]):.6f} {float(label[2]):.6f} {float(label[3]):.6f} {float(label[4]):.6f}"
                    for label in entry["labels"]
                ]
                label_path.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")
            _link_or_copy_immutable(source, destination)
            stats[split] += 1
            stats["total"] += 1
        if task_type == ProjectTaskType.DETECT.value:
            import yaml

            dataset_config = {
                "path": str(out_dir.resolve()),
                "train": "images/train",
                "val": "images/val",
                "names": category_names,
            }
            if stats["test"]:
                dataset_config["test"] = "images/test"
            (out_dir / "dataset.yaml").write_text(
                yaml.safe_dump(
                    dataset_config,
                    allow_unicode=True,
                    sort_keys=False,
                ),
                encoding="utf-8",
            )
        return stats


def run_dataset_snapshot_task(db: Session, task: Task) -> None:
    project = db.get(Project, task.project_id)
    if not project:
        raise RuntimeError("Project not found")
    service = DatasetService(DatasetVersionRepository(db))
    version: DatasetVersionDTO | None = None
    try:
        version = service.create_version(
            project.id,
            project.task_type,
            val_ratio=float((task.params or {}).get("val_ratio", 0.2)),
        )
        frame_count = len(version.manifest.get("frames") or [])
        task.progress = frame_count
        task.total = frame_count
        task.result = {"dataset_version_id": version.id, "version": version.version}
        db.commit()
    except Exception:
        db.rollback()
        if version and version.snapshot_path.exists():
            shutil.rmtree(version.snapshot_path)
        raise


def reconcile_dataset_version_files(db: Session) -> int:
    """Remove internal snapshot directories that have no database record."""
    referenced = {
        Path(path).resolve(strict=False)
        for (path,) in db.query(DatasetVersion.snapshot_path).all()
    }
    removed = 0
    for (project_id,) in db.query(Project.id).all():
        root = dataset_versions_dir(project_id).resolve(strict=False)
        if not root.is_dir():
            continue
        for child in root.iterdir():
            resolved = child.resolve(strict=False)
            if not child.is_dir() or resolved.parent != root or resolved in referenced:
                continue
            shutil.rmtree(resolved)
            removed += 1
    return removed
