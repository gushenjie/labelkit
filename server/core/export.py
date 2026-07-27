"""Dataset export task."""

from __future__ import annotations

import shutil
from collections.abc import Callable
from pathlib import Path

from sqlalchemy.orm import Session

from server.core.paths import exports_dir
from server.core.train import prepare_classify_dataset, prepare_dataset
from server.db.models import Project, ProjectTaskType, Task


def run_export_task(db: Session, task: Task, *, log: Callable[[str], None] | None = None) -> None:
    project = db.get(Project, task.project_id)
    custom_dir = (task.params.get("output_dir") or "").strip()

    if custom_dir:
        out_dir = Path(custom_dir).expanduser().resolve()
        if not out_dir.is_absolute():
            raise RuntimeError("导出路径必须是绝对路径")
        if out_dir.exists() and any(out_dir.iterdir()):
            if not task.params.get("overwrite"):
                raise RuntimeError(f"目录非空: {out_dir}，请选空文件夹或确认覆盖")
            shutil.rmtree(out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
    else:
        out_dir = exports_dir(project.id) / f"export_{task.id}"
        if out_dir.exists():
            shutil.rmtree(out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)

    val_ratio = float(task.params.get("val_ratio", 0.2))

    if project.task_type == ProjectTaskType.CLASSIFY:
        stats = prepare_classify_dataset(db, project, out_dir, val_ratio=val_ratio)
    else:
        stats = prepare_dataset(db, project, out_dir, val_ratio=val_ratio)

    task.total = stats["total"]
    task.progress = stats["total"]
    task.result = {"path": str(out_dir), "stats": stats}
    if log:
        log(f"导出完成: {out_dir} · 训练 {stats['train']} / 验证 {stats['val']}")
    db.commit()
