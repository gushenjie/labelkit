"""Background task worker."""

from __future__ import annotations

import shutil
import threading
import traceback
from datetime import datetime, timezone
from pathlib import Path

import cv2
from sqlalchemy.orm import Session

from server.config import settings
from server.core.dedup import compute_phash, deduplicate_paths
from server.core.extract import extract_frames
from server.core.paths import frames_dir, labels_dir, models_dir, videos_dir
from server.db.database import SessionLocal
from server.db.models import (
    Annotation,
    Frame,
    FrameStatus,
    ModelVersion,
    Project,
    ProjectTaskType,
    Task,
    TaskStatus,
    TaskType,
    Video,
)


class TaskWorker:
    _lock = threading.Lock()
    _running: dict[str, threading.Thread] = {}
    _cancel: set[str] = set()

    @classmethod
    def is_running(cls, project_id: str) -> bool:
        t = cls._running.get(project_id)
        return bool(t and t.is_alive())

    @classmethod
    def reconcile_stale_tasks(cls, db: Session, project_id: str | None = None) -> int:
        """将无对应工作线程的 running 任务标记为已取消（常见于服务重启）。"""
        q = db.query(Task).filter(Task.status == TaskStatus.RUNNING)
        if project_id:
            q = q.filter(Task.project_id == project_id)
        fixed = 0
        now = datetime.now(timezone.utc)
        for task in q.all():
            thread = cls._running.get(task.project_id)
            if thread and thread.is_alive():
                continue
            task.status = TaskStatus.CANCELLED
            task.finished_at = now
            task.log = (task.log + "\n任务已中断（服务重启或异常退出）").strip()
            fixed += 1
        if fixed:
            db.commit()
        return fixed

    @classmethod
    def cancel(cls, task_id: str) -> None:
        cls._cancel.add(task_id)

    @classmethod
    def start(cls, task_id: str) -> None:
        with cls._lock:
            t = threading.Thread(target=cls._run, args=(task_id,), daemon=True)
            t.start()

    @classmethod
    def _run(cls, task_id: str) -> None:
        db = SessionLocal()
        task = None
        try:
            task = db.get(Task, task_id)
            if not task:
                return
            cls._running[task.project_id] = threading.current_thread()
            task.status = TaskStatus.RUNNING
            task.started_at = datetime.now(timezone.utc)
            db.commit()

            handler = {
                TaskType.EXTRACT: cls._handle_extract,
                TaskType.DEDUP: cls._handle_dedup,
                TaskType.LABEL: cls._handle_label,
                TaskType.REVIEW: cls._handle_review,
                TaskType.TRAIN: cls._handle_train,
                TaskType.EXPORT: cls._handle_export,
                TaskType.RELABEL: cls._handle_relabel,
                TaskType.IMPORT: cls._handle_import,
                TaskType.DERIVE_CLASSIFY: cls._handle_derive_classify,
            }.get(task.task_type)

            if not handler:
                raise RuntimeError(f"Unsupported task type: {task.task_type}")

            handler(db, task)

            if task_id in cls._cancel:
                task.status = TaskStatus.CANCELLED
            else:
                task.status = TaskStatus.COMPLETED
            task.finished_at = datetime.now(timezone.utc)
            db.commit()
        except Exception as e:
            task = db.get(Task, task_id)
            if task:
                task.status = TaskStatus.FAILED
                task.error = str(e)
                task.log += f"\n[ERROR] {traceback.format_exc()}"
                task.finished_at = datetime.now(timezone.utc)
                db.commit()
        finally:
            if task:
                cls._running.pop(task.project_id, None)
            cls._cancel.discard(task_id)
            db.close()

    @classmethod
    def _append_log(cls, db: Session, task: Task, msg: str) -> None:
        task.log = (task.log + "\n" + msg).strip()
        db.commit()

    @classmethod
    def _cancelled(cls, task_id: str) -> bool:
        return task_id in cls._cancel

    @classmethod
    def _handle_extract(cls, db: Session, task: Task) -> None:
        project = db.get(Project, task.project_id)
        if not project:
            raise RuntimeError("Project not found")

        video_ids = task.params.get("video_ids", [])
        target_fps = float(task.params.get("target_fps", 1.0))
        max_frames = int(task.params.get("max_frames", 0))
        split = task.params.get("split", "train")

        videos = db.query(Video).filter(Video.project_id == project.id)
        if video_ids:
            videos = videos.filter(Video.id.in_(video_ids))
        videos = videos.all()

        task.total = len(videos)
        db.commit()

        extracted_count = 0
        for i, video in enumerate(videos):
            if cls._cancelled(task.id):
                break
            # 重新提取时先清理该视频旧帧，避免重复累积
            old_frames = db.query(Frame).filter(Frame.video_id == video.id).all()
            for frame in old_frames:
                Path(frame.filepath).unlink(missing_ok=True)
                db.delete(frame)
            if old_frames:
                db.flush()

            out_dir = frames_dir(project.id, split)
            prefix = Path(video.filename).stem
            paths = extract_frames(
                Path(video.filepath),
                out_dir,
                target_fps=target_fps,
                max_frames=max_frames,
                prefix=prefix,
            )
            for j, p in enumerate(paths):
                phash = compute_phash(p)
                frame = Frame(
                    project_id=project.id,
                    video_id=video.id,
                    filename=p.name,
                    filepath=str(p),
                    split=split,
                    phash=phash,
                    frame_index=j,
                )
                db.add(frame)
            extracted_count += len(paths)
            task.progress = i + 1
            cls._append_log(db, task, f"抽帧: {video.filename} -> {len(paths)} 张")
            db.commit()

        if not extracted_count:
            cls._append_log(db, task, "未抽到任何帧")
        db.commit()

        auto_dedup = task.params.get("auto_dedup", True)
        if auto_dedup and not cls._cancelled(task.id):
            threshold = int(task.params.get("threshold", 8))
            kept, removed_count = cls._run_dedup(db, task, project.id, split=split, threshold=threshold)
            task.result = {
                "extracted": extracted_count,
                "kept": kept,
                "removed": removed_count,
            }
            db.commit()

    @classmethod
    def _run_dedup(
        cls,
        db: Session,
        task: Task,
        project_id: str,
        *,
        split: str | None = None,
        threshold: int = 8,
    ) -> tuple[int, int]:
        q = db.query(Frame).filter(Frame.project_id == project_id)
        if split:
            q = q.filter(Frame.split == split)
        frames = q.order_by(Frame.created_at).all()

        paths = [Path(f.filepath) for f in frames if Path(f.filepath).exists()]
        kept, removed_paths = deduplicate_paths(paths, threshold=threshold)
        kept_set = {p.resolve() for p in kept}
        removed_count = 0

        for frame in frames:
            if cls._cancelled(task.id):
                break
            p = Path(frame.filepath).resolve()
            if p not in kept_set and p.exists():
                p.unlink(missing_ok=True)
                db.delete(frame)
                removed_count += 1

        cls._append_log(db, task, f"去重完成: 保留 {len(kept)}, 删除 {removed_count}")
        db.commit()
        return len(kept), removed_count

    @classmethod
    def _handle_dedup(cls, db: Session, task: Task) -> None:
        project = db.get(Project, task.project_id)
        threshold = int(task.params.get("threshold", 8))
        split = task.params.get("split")
        frames = db.query(Frame).filter(Frame.project_id == project.id)
        if split:
            frames = frames.filter(Frame.split == split)
        task.total = frames.count()
        db.commit()
        kept, removed_count = cls._run_dedup(db, task, project.id, split=split, threshold=threshold)
        task.progress = task.total
        task.result = {"kept": kept, "removed": removed_count}
        db.commit()

    @classmethod
    def _handle_label(cls, db: Session, task: Task) -> None:
        from server.core.label_runner import run_label_task

        run_label_task(db, task, is_cancelled=lambda: cls._cancelled(task.id))

    @classmethod
    def _handle_review(cls, db: Session, task: Task) -> None:
        from server.core.review import run_review_task

        run_review_task(db, task, cancelled=lambda: cls._cancelled(task.id))

    @classmethod
    def _handle_train(cls, db: Session, task: Task) -> None:
        from server.core.train import run_train_task

        run_train_task(db, task, log=lambda m: cls._append_log(db, task, m))

    @classmethod
    def _handle_export(cls, db: Session, task: Task) -> None:
        from server.core.export import run_export_task

        run_export_task(db, task, log=lambda m: cls._append_log(db, task, m))

    @classmethod
    def _handle_relabel(cls, db: Session, task: Task) -> None:
        from server.core.relabel import run_relabel_task

        run_relabel_task(db, task, cancelled=lambda: cls._cancelled(task.id))

    @classmethod
    def _handle_import(cls, db: Session, task: Task) -> None:
        from server.core.import_dataset import run_import_task

        run_import_task(db, task, log=lambda m: cls._append_log(db, task, m))

    @classmethod
    def _handle_derive_classify(cls, db: Session, task: Task) -> None:
        from server.core.derive_classify import run_derive_classify_task

        run_derive_classify_task(db, task, log=lambda m: cls._append_log(db, task, m))
