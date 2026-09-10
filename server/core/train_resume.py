"""训练断点续训辅助。"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from server.core.paths import exports_dir


def training_run_dir(project_id: str, task_id: str) -> Path:
    return exports_dir(project_id) / "training_runs" / f"task_{task_id}"


def training_dataset_dir(project_id: str, task_id: str) -> Path:
    return exports_dir(project_id) / f"train_{task_id}"


def find_resume_checkpoint(project_id: str, task_id: str) -> Path | None:
    """返回指定任务目录下可续训的 last.pt；不存在或过小则视为不可用。"""
    last = training_run_dir(project_id, task_id) / "weights" / "last.pt"
    if last.is_file() and last.stat().st_size >= 1_000_000:
        return last
    return None


def resume_candidate_task_ids(task_id: str, *, params: dict[str, Any] | None = None, retry_of_task_id: str | None = None) -> list[str]:
    """续训断点查找顺序：当前任务 → resume_from → retry_of。"""
    candidates: list[str] = []
    for value in (
        task_id,
        str((params or {}).get("resume_from_task_id") or "").strip(),
        str(retry_of_task_id or "").strip(),
    ):
        if value and value not in candidates:
            candidates.append(value)
    return candidates


def resolve_resume_checkpoint(
    project_id: str,
    task_id: str,
    *,
    params: dict[str, Any] | None = None,
    retry_of_task_id: str | None = None,
) -> tuple[Path, str] | None:
    """定位可用 last.pt 及其所属运行目录任务 ID（续训链会落到源头任务）。"""
    for candidate in resume_candidate_task_ids(
        task_id,
        params=params,
        retry_of_task_id=retry_of_task_id,
    ):
        checkpoint = find_resume_checkpoint(project_id, candidate)
        if checkpoint is not None:
            return checkpoint, candidate
    return None


def can_resume_train_task(
    project_id: str,
    task_id: str,
    *,
    status: str,
    task_type: str,
    params: dict[str, Any] | None = None,
    retry_of_task_id: str | None = None,
) -> bool:
    if task_type != "train":
        return False
    if status not in {"interrupted", "failed"}:
        return False
    return (
        resolve_resume_checkpoint(
            project_id,
            task_id,
            params=params,
            retry_of_task_id=retry_of_task_id,
        )
        is not None
    )
