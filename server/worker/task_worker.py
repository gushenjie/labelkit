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
from server.core.paths import cache_dir, frames_dir, label_path_for_frame, models_dir, videos_dir
from server.db.database import SessionLocal
from server.db.models import (
    Annotation,
    Frame,
    FrameStatus,
    ModelVersion,
    PublicDatasetImport,
    Project,
    ProjectExecutionLease,
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
        """Mark unfinished tasks interrupted on process startup; never rerun them."""
        q = db.query(Task).filter(
            Task.status.in_({TaskStatus.PENDING, TaskStatus.RUNNING, TaskStatus.PAUSED})
        )
        if project_id:
            q = q.filter(Task.project_id == project_id)
        fixed = 0
        now = datetime.now(timezone.utc)
        for task in q.all():
            thread = cls._running.get(task.project_id)
            if thread and thread.is_alive():
                continue
            task.status = TaskStatus.INTERRUPTED
            task.finished_at = now
            task.log = (task.log + "\n任务已中断（服务重启或异常退出）；请手动重试").strip()
            import_id = str(task.params.get("import_id") or "")
            public_import = db.get(PublicDatasetImport, import_id) if import_id else None
            if public_import and task.task_type == TaskType.PUBLIC_FETCH:
                public_import.state = "fetch_interrupted"
            elif public_import and task.task_type == TaskType.PUBLIC_IMPORT and public_import.state == "publishing":
                public_import.state = "publish_interrupted"
            if task.task_type == TaskType.TRAIN:
                linked_imports = db.query(PublicDatasetImport).filter(
                    PublicDatasetImport.train_task_id == task.id
                ).all()
                for linked_import in linked_imports:
                    linked_import.state = "training_interrupted"
            fixed += 1
        lease_query = db.query(ProjectExecutionLease)
        if project_id:
            lease_query = lease_query.filter(ProjectExecutionLease.project_id == project_id)
        released = lease_query.delete(synchronize_session=False)
        if fixed or released:
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
            task.heartbeat_at = task.started_at
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
                TaskType.PUBLIC_FETCH: cls._handle_public_fetch,
                TaskType.PUBLIC_IMPORT: cls._handle_public_import,
            }.get(task.task_type)

            if not handler:
                raise RuntimeError(f"Unsupported task type: {task.task_type}")

            handler(db, task)

            if cls._cancelled(db, task_id):
                task.status = TaskStatus.CANCELLED
            else:
                task.status = TaskStatus.COMPLETED
            if task.task_type == TaskType.TRAIN:
                db.query(PublicDatasetImport).filter(
                    PublicDatasetImport.train_task_id == task.id
                ).update(
                    {
                        PublicDatasetImport.state: (
                            "training_cancelled"
                            if task.status == TaskStatus.CANCELLED
                            else "completed"
                        )
                    },
                    synchronize_session=False,
                )
            task.finished_at = datetime.now(timezone.utc)
            db.commit()
        except Exception as e:
            db.rollback()
            task = db.get(Task, task_id)
            if task:
                if task_id in cls._cancel or task.cancel_requested:
                    task.status = TaskStatus.CANCELLED
                    task.log = (task.log + "\n任务已取消").strip()
                else:
                    task.status = TaskStatus.FAILED
                    task.error = str(e)
                    task.log += f"\n[ERROR] {traceback.format_exc()}"
                if task.task_type == TaskType.TRAIN:
                    db.query(PublicDatasetImport).filter(
                        PublicDatasetImport.train_task_id == task.id
                    ).update(
                        {
                            PublicDatasetImport.state: (
                                "training_cancelled"
                                if task.status == TaskStatus.CANCELLED
                                else "training_failed"
                            )
                        },
                        synchronize_session=False,
                    )
                task.finished_at = datetime.now(timezone.utc)
                db.commit()
        finally:
            if task:
                cls._running.pop(task.project_id, None)
                db.query(ProjectExecutionLease).filter(
                    ProjectExecutionLease.project_id == task.project_id,
                    ProjectExecutionLease.task_id == task.id,
                ).delete(synchronize_session=False)
                db.commit()
            cls._cancel.discard(task_id)
            db.close()

    @classmethod
    def _append_log(cls, db: Session, task: Task, msg: str) -> None:
        task.log = (task.log + "\n" + msg).strip()
        task.heartbeat_at = datetime.now(timezone.utc)
        db.commit()

    @classmethod
    def _cancelled(cls, db: Session, task_id: str) -> bool:
        if task_id in cls._cancel:
            return True
        return bool(db.query(Task.cancel_requested).filter(Task.id == task_id).scalar())

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
        extracted_frame_ids: list[str] = []
        for i, video in enumerate(videos):
            if cls._cancelled(db, task.id):
                break
            # 只清理可安全重建的未标注帧；历史确认帧和任何带标注帧必须保留。
            old_frames = (
                db.query(Frame)
                .filter(
                    Frame.video_id == video.id,
                    Frame.status == FrameStatus.UNLABELED,
                    ~Frame.annotations.any(),
                )
                .all()
            )
            for frame in old_frames:
                cls._delete_frame_artifacts(project.id, frame)
                db.delete(frame)
            if old_frames:
                db.flush()

            out_dir = frames_dir(project.id, split)
            prefix = video.storage_key or video.id
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
                    storage_key=p.stem,
                    source_group_id=video.id,
                    filepath=str(p),
                    split=split,
                    phash=phash,
                    frame_index=j,
                )
                db.add(frame)
                db.flush()
                extracted_frame_ids.append(frame.id)
            extracted_count += len(paths)
            task.progress = i + 1
            cls._append_log(db, task, f"抽帧: {video.filename} -> {len(paths)} 张")
            db.commit()

        if not extracted_count:
            cls._append_log(db, task, "未抽到任何帧")
        db.commit()

        auto_dedup = task.params.get("auto_dedup", True)
        if auto_dedup and not cls._cancelled(db, task.id):
            threshold = int(task.params.get("threshold", 8))
            kept, removed_count = cls._run_dedup(
                db,
                task,
                project.id,
                frame_ids=extracted_frame_ids,
                threshold=threshold,
                apply=True,
            )
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
        frame_ids: list[str] | None = None,
        split: str | None = None,
        threshold: int = 8,
        apply: bool = False,
    ) -> tuple[int, int]:
        q = db.query(Frame).filter(
            Frame.project_id == project_id,
            Frame.status == FrameStatus.UNLABELED,
            ~Frame.annotations.any(),
        )
        if frame_ids is not None:
            if not frame_ids:
                return 0, 0
            q = q.filter(Frame.id.in_(frame_ids))
        if split:
            q = q.filter(Frame.split == split)
        frames = q.order_by(Frame.created_at).all()

        paths = [Path(f.filepath) for f in frames if Path(f.filepath).exists()]
        kept, removed_paths = deduplicate_paths(paths, threshold=threshold)
        kept_set = {p.resolve() for p in kept}
        duplicate_frames = [
            frame
            for frame in frames
            if Path(frame.filepath).exists()
            and Path(frame.filepath).resolve() not in kept_set
        ]

        if not apply:
            cls._append_log(
                db,
                task,
                f"去重预览: 将保留 {len(kept)}，发现 {len(duplicate_frames)} 个可删除的未标注重复帧",
            )
            return len(kept), len(duplicate_frames)

        removed_count = 0

        for frame in duplicate_frames:
            if cls._cancelled(db, task.id):
                break
            cls._delete_frame_artifacts(project_id, frame)
            db.delete(frame)
            removed_count += 1

        cls._append_log(db, task, f"去重完成: 保留 {len(kept)}, 删除 {removed_count}")
        db.commit()
        return len(kept), removed_count

    @staticmethod
    def _delete_frame_artifacts(project_id: str, frame: Frame) -> None:
        Path(frame.filepath).unlink(missing_ok=True)
        label_path_for_frame(project_id, frame).unlink(missing_ok=True)
        project_cache = cache_dir(project_id)
        for candidate in (
            project_cache / "previews" / f"{frame.id}.jpg",
            project_cache / "review_images" / f"{frame.id}.jpg",
        ):
            candidate.unlink(missing_ok=True)

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
        apply = bool(task.params.get("apply", False))
        kept, removed_count = cls._run_dedup(
            db,
            task,
            project.id,
            split=split,
            threshold=threshold,
            apply=apply,
        )
        task.progress = task.total
        task.result = {
            "kept": kept,
            "removed": removed_count if apply else 0,
            "would_remove": 0 if apply else removed_count,
            "dry_run": not apply,
        }
        db.commit()

    @classmethod
    def _handle_label(cls, db: Session, task: Task) -> None:
        from server.core.label_runner import run_label_task

        run_label_task(db, task, is_cancelled=lambda: cls._cancelled(db, task.id))

    @classmethod
    def _handle_review(cls, db: Session, task: Task) -> None:
        from server.core.review import run_review_task

        run_review_task(db, task, cancelled=lambda: cls._cancelled(db, task.id))

    @classmethod
    def _handle_train(cls, db: Session, task: Task) -> None:
        from server.core.train import run_train_task

        run_train_task(
            db,
            task,
            log=lambda m: cls._append_log(db, task, m),
            cancelled=lambda: cls._cancelled(db, task.id),
        )

    @classmethod
    def _handle_export(cls, db: Session, task: Task) -> None:
        from server.core.export import run_export_task

        run_export_task(
            db,
            task,
            log=lambda m: cls._append_log(db, task, m),
            cancelled=lambda: cls._cancelled(db, task.id),
        )

    @classmethod
    def _handle_relabel(cls, db: Session, task: Task) -> None:
        from server.core.relabel import run_relabel_task

        run_relabel_task(db, task, cancelled=lambda: cls._cancelled(db, task.id))

    @classmethod
    def _handle_import(cls, db: Session, task: Task) -> None:
        from server.core.import_dataset import run_import_task

        run_import_task(
            db,
            task,
            log=lambda m: cls._append_log(db, task, m),
            cancelled=lambda: cls._cancelled(db, task.id),
        )

    @classmethod
    def _handle_derive_classify(cls, db: Session, task: Task) -> None:
        from server.core.derive_classify import run_derive_classify_task

        run_derive_classify_task(
            db,
            task,
            log=lambda m: cls._append_log(db, task, m),
            cancelled=lambda: cls._cancelled(db, task.id),
        )

    @classmethod
    def _handle_public_fetch(cls, db: Session, task: Task) -> None:
        from server.core.public_dataset_workflow import fetch_and_inspect
        from server.repositories.public_dataset_repository import PublicDatasetRepository

        repository = PublicDatasetRepository(db)
        import_id = str(task.params.get("import_id") or "")

        def progress(written: int, expected: int) -> None:
            task.progress = written
            task.total = expected
            task.heartbeat_at = datetime.now(timezone.utc)
            db.commit()

        try:
            record = fetch_and_inspect(
                repository,
                import_id,
                cancelled=lambda: cls._cancelled(db, task.id),
                log=lambda message: cls._append_log(db, task, message),
                progress=progress,
            )
            task.result = {
                "import_id": record.id,
                "format": record.detected_format,
                "images": record.quality_report.get("image_count", 0),
            }
            db.commit()
        except Exception:
            db.rollback()
            record = repository.get_by_id(import_id)
            if record:
                repository.update(import_id, state="fetch_failed")
                db.commit()
            raise

    @classmethod
    def _handle_public_import(cls, db: Session, task: Task) -> None:
        from server.core.label_runner import run_label_task
        from server.core.public_dataset_workflow import (
            finalize_published_import,
            prepare_review_after_labeling,
            publish_import,
        )
        from server.repositories.public_dataset_repository import PublicDatasetRepository

        repository = PublicDatasetRepository(db)
        import_id = str(task.params.get("import_id") or "")
        record = repository.get_by_id(import_id)
        if not record:
            raise RuntimeError(f"Public dataset import not found: {import_id}")
        try:
            record, frame_ids = publish_import(
                repository,
                import_id,
                class_mapping=record.class_mapping,
                warnings_confirmed=bool(record.workflow_metadata.get("warnings_confirmed")),
                cancelled=lambda: cls._cancelled(db, task.id),
            )
            db.commit()
            finalize_published_import(record)
            if record.state == "needs_label" and record.workflow_metadata.get("auto_label"):
                task.params = {
                    **task.params,
                    "frame_ids": list(frame_ids),
                    "only_status": FrameStatus.UNLABELED.value,
                    "force": False,
                }
                db.commit()
                run_label_task(
                    db,
                    task,
                    is_cancelled=lambda: cls._cancelled(db, task.id),
                )
                record = prepare_review_after_labeling(repository, import_id)
                db.commit()
            task.result = {
                **dict(task.result or {}),
                "import_id": import_id,
                "published": len(frame_ids),
                "state": record.state,
                "review_samples": len(record.review_frame_ids),
            }
            db.commit()
        except Exception as error:
            db.rollback()
            record = repository.get_by_id(import_id)
            if record and record.state == "publishing":
                metadata = {**record.workflow_metadata, "last_publish_error": str(error)}
                repository.update(import_id, state="fetched", workflow_metadata=metadata)
                db.commit()
            raise
