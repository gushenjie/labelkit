"""Dataset export task."""

from __future__ import annotations

import json
import shutil
from collections.abc import Callable
from pathlib import Path

from sqlalchemy.orm import Session

from server.config import settings
from server.core.dataset_service import DatasetService, DatasetVersionRepository
from server.core.paths import exports_dir
from server.db.models import Project, ProjectTaskType, Task

EXPORT_MARKER = ".labelkit-export.json"


def _resolve_export_target(project_id: str, task: Task) -> Path:
    custom_dir = (task.params.get("output_dir") or "").strip()
    if not custom_dir:
        return exports_dir(project_id) / f"export_{task.id}"

    raw = Path(custom_dir).expanduser()
    if not raw.is_absolute():
        raise RuntimeError("导出路径必须是绝对路径")
    target = raw.resolve(strict=False)
    if target == Path(target.anchor):
        raise RuntimeError("禁止导出到磁盘根目录")
    data_root = settings.data_dir.resolve(strict=False)
    if target == data_root or data_root in target.parents:
        raise RuntimeError("禁止导出到 LabelKit 项目数据目录")
    return target


def _validate_existing_target(target: Path, overwrite: bool) -> None:
    if not target.exists():
        return
    if not target.is_dir():
        raise RuntimeError(f"导出路径不是目录: {target}")
    if not any(target.iterdir()):
        return
    if not (target / EXPORT_MARKER).is_file():
        raise RuntimeError(f"拒绝覆盖未带 LabelKit 标记的非空目录: {target}")
    if not overwrite:
        raise RuntimeError(f"目录中已有 LabelKit 导出: {target}，请确认覆盖")


def _publish_export(staging: Path, target: Path, task_id: str) -> None:
    backup = target.parent / f".{target.name}.labelkit-backup-{task_id}"
    moved_old = False
    try:
        if target.exists():
            target.replace(backup)
            moved_old = True
        staging.replace(target)
    except Exception:
        if moved_old and backup.exists() and not target.exists():
            backup.replace(target)
        raise
    if backup.exists():
        shutil.rmtree(backup)


def run_export_task(
    db: Session,
    task: Task,
    *,
    log: Callable[[str], None] | None = None,
    cancelled: Callable[[], bool] | None = None,
) -> None:
    project = db.get(Project, task.project_id)
    if not project:
        raise RuntimeError("Project not found")
    out_dir = _resolve_export_target(project.id, task)
    _validate_existing_target(out_dir, bool(task.params.get("overwrite", False)))
    out_dir.parent.mkdir(parents=True, exist_ok=True)
    staging = out_dir.parent / f".{out_dir.name}.labelkit-staging-{task.id}"
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)

    val_ratio = float(task.params.get("val_ratio", 0.2))
    dataset_service = DatasetService(DatasetVersionRepository(db))
    requested_version_id = (task.params.get("dataset_version_id") or "").strip()
    version = (
        dataset_service.get_version(project.id, requested_version_id)
        if requested_version_id
        else dataset_service.create_version(project.id, project.task_type, val_ratio=val_ratio)
    )
    db.commit()

    try:
        stats = dataset_service.materialize(version, staging, cancelled=cancelled)

        (staging / EXPORT_MARKER).write_text(
            json.dumps(
                {"format": "labelkit-export", "version": 1, "project_id": project.id},
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        _publish_export(staging, out_dir, task.id)
    except Exception:
        if staging.exists():
            shutil.rmtree(staging)
        raise

    task.total = stats["total"]
    task.progress = stats["total"]
    task.result = {"path": str(out_dir), "stats": stats, "dataset_version_id": version.id}
    if log:
        log(f"导出完成: {out_dir} · 训练 {stats['train']} / 验证 {stats['val']}")
    db.commit()
