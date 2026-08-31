"""Derive classify project from detect project crops."""

from __future__ import annotations

import uuid
from collections.abc import Callable
from pathlib import Path

import cv2
from sqlalchemy.orm import Session

from server.core.image_io import read_image_bgr, write_image_bgr
from server.core.paths import frames_dir, label_path_for_frame
from server.core.yolo_io import parse_labels, yolo_to_xywh
from server.db.models import Annotation, Category, Frame, FrameStatus, Project, ProjectTaskType, Task


def crop_from_bbox(
    frame: cv2.Mat,
    bbox: tuple[int, int, int, int],
    *,
    pad_x: float = 0.1,
    pad_y: float = 0.35,
) -> cv2.Mat | None:
    fh, fw = frame.shape[:2]
    x, y, w, h = bbox
    x1 = int(max(0, x - w * pad_x))
    x2 = int(min(fw, x + w * (1 + pad_x)))
    y1 = int(max(0, y - h * pad_y))
    y2 = int(min(fh, y + h * (1 + pad_y)))
    if x2 - x1 < 24 or y2 - y1 < 24:
        return None
    return frame[y1:y2, x1:x2]


def run_derive_classify_task(
    db: Session,
    task: Task,
    *,
    log: Callable[[str], None] | None = None,
    cancelled: Callable[[], bool] | None = None,
) -> None:
    project = db.get(Project, task.project_id)
    if project.task_type != ProjectTaskType.CLASSIFY:
        raise RuntimeError("Target project must be classify type")

    source_project_id = task.params.get("source_project_id")
    source_class_id = int(task.params.get("source_class_id", 1))
    target_class_id = task.params.get("target_class_id")

    source = db.get(Project, source_project_id)
    if not source:
        raise RuntimeError("Source project not found")

    frames = db.query(Frame).filter(
        Frame.project_id == source_project_id,
        Frame.status.in_({FrameStatus.AUTO_OK, FrameStatus.HUMAN_OK}),
    ).all()

    task.total = len(frames)
    db.flush()
    created = 0
    created_paths: list[Path] = []
    preview_frame_ids: list[str] = []
    categories = db.query(Category).filter(Category.project_id == project.id).all()
    target_cat = (
        next((category for category in categories if category.class_id == int(target_class_id)), None)
        if target_class_id is not None
        else (categories[0] if categories else None)
    )
    if not target_cat:
        raise RuntimeError("Target category not found")

    try:
        for i, src_frame in enumerate(frames):
            if cancelled and cancelled():
                raise RuntimeError("任务已取消")
            lbl_path = label_path_for_frame(source_project_id, src_frame)
            if not lbl_path.exists():
                continue
            labels = parse_labels(lbl_path.read_text(encoding="utf-8"))
            source_labels = [label for label in labels if label[0] == source_class_id]
            if not source_labels:
                continue

            img = read_image_bgr(Path(src_frame.filepath))
            if img is None:
                continue
            ih, iw = img.shape[:2]

            for box_index, (_cls_id, xc, yc, w, h) in enumerate(source_labels):
                bbox = yolo_to_xywh(xc, yc, w, h, iw, ih)
                crop = crop_from_bbox(img, bbox)
                if crop is None:
                    continue

                storage_key = uuid.uuid4().hex
                out_dir = frames_dir(project.id, "train")
                out_path = out_dir / f"{storage_key}.jpg"
                write_image_bgr(out_path, crop, quality=92)
                created_paths.append(out_path)

                frame = Frame(
                    project_id=project.id,
                    filename=f"crop_{Path(src_frame.filename).stem}_{box_index + 1}.jpg",
                    storage_key=storage_key,
                    source_group_id=src_frame.source_group_id or src_frame.video_id or src_frame.id,
                    filepath=str(out_path),
                    split="train",
                    status=FrameStatus.NEEDS_HUMAN,
                    note=f"派生自 {source.name} / 类别 {source_class_id}",
                    source="derive",
                )
                db.add(frame)
                db.flush()
                db.add(Annotation(frame_id=frame.id, class_id=target_cat.class_id, source="derive"))
                if len(preview_frame_ids) < 20:
                    preview_frame_ids.append(frame.id)
                created += 1
            task.progress = i + 1
    except Exception:
        for path in created_paths:
            path.unlink(missing_ok=True)
        raise

    task.result = {
        "created": created,
        "source_project_id": source.id,
        "source_class_id": source_class_id,
        "target_class_id": target_cat.class_id,
        "preview_frame_ids": preview_frame_ids,
    }
    if log:
        log(f"派生分类素材: {created} 张")
    db.commit()
