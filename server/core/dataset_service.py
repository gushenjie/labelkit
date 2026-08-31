"""Immutable dataset snapshots and source-group-safe splitting."""

from __future__ import annotations

import hashlib
import json
import shutil
import os
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy.orm import Session

from server.core.paths import dataset_versions_dir
from server.db.models import (
    Category,
    DatasetVersion,
    Frame,
    FrameStatus,
    ProjectTaskType,
)

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


class DatasetVersionRepository:
    def __init__(self, db: Session):
        self._db = db

    def list_frames(self, project_id: str, task_type: ProjectTaskType) -> list[SnapshotFrameInput]:
        frames = (
            self._db.query(Frame)
            .filter(Frame.project_id == project_id, Frame.status.in_(TRAINABLE))
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
        return self._db.query(DatasetVersion).filter(DatasetVersion.project_id == project_id).count() + 1

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
                        "split": split_map[frame.id],
                        "image": relative_image.as_posix(),
                        "image_checksum": _sha256_file(snapshot_image),
                        "labels": labels,
                        "label_checksum": hashlib.sha256(label_payload.encode("utf-8")).hexdigest(),
                    }
                )
            manifest = {
                "schema_version": 1,
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
        self._repository.save(version)
        return version

    def get_version(self, project_id: str, version_id: str) -> DatasetVersionDTO:
        version = self._repository.get(version_id, project_id)
        if not version:
            raise RuntimeError(f"Dataset version not found: {version_id}")
        return version

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
