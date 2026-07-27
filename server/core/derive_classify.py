"""Derive classify project from detect project crops."""

from __future__ import annotations

import shutil
from collections.abc import Callable
from pathlib import Path

import cv2
from sqlalchemy.orm import Session

from server.core.paths import frames_dir
from server.core.yolo_io import parse_labels, yolo_to_xywh
from server.core.paths import labels_dir as get_labels_dir
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


def run_derive_classify_task(db: Session, task: Task, *, log: Callable[[str], None] | None = None) -> None:
    project = db.get(Project, task.project_id)
    if project.task_type != ProjectTaskType.CLASSIFY:
        raise RuntimeError("Target project must be classify type")

    source_project_id = task.params.get("source_project_id")
    source_class_id = int(task.params.get("source_class_id", 1))
    label_mapping: dict[str, str] = task.params.get("label_mapping", {})

    source = db.get(Project, source_project_id)
    if not source:
        raise RuntimeError("Source project not found")

    frames = db.query(Frame).filter(
        Frame.project_id == source_project_id,
        Frame.status.in_({FrameStatus.AUTO_OK, FrameStatus.HUMAN_OK}),
    ).all()

    task.total = len(frames)
    db.commit()
    created = 0

    for i, src_frame in enumerate(frames):
        lbl_path = get_labels_dir(source_project_id, src_frame.split) / f"{Path(src_frame.filename).stem}.txt"
        if not lbl_path.exists():
            continue
        labels = parse_labels(lbl_path.read_text(encoding="utf-8"))
        if source_class_id not in labels:
            continue

        img = cv2.imread(src_frame.filepath)
        if img is None:
            continue
        ih, iw = img.shape[:2]
        bbox = yolo_to_xywh(*labels[source_class_id], iw, ih)
        crop = crop_from_bbox(img, bbox)
        if crop is None:
            continue

        # Determine classify label from source frame prefix or mapping
        cls_name = label_mapping.get(src_frame.filename[:3], "unknown")
        cats = db.query(Category).filter(Category.project_id == project.id).all()
        target_cat = next((c for c in cats if c.name == cls_name), None)
        if not target_cat and cats:
            target_cat = cats[0]

        out_dir = frames_dir(project.id, "train")
        out_path = out_dir / f"crop_{src_frame.id}_{created:06d}.jpg"
        cv2.imwrite(str(out_path), crop, [cv2.IMWRITE_JPEG_QUALITY, 92])

        frame = Frame(
            project_id=project.id,
            filename=out_path.name,
            filepath=str(out_path),
            split="train",
            status=FrameStatus.UNLABELED,
            source="derive",
        )
        db.add(frame)
        db.flush()
        if target_cat:
            db.add(Annotation(frame_id=frame.id, class_id=target_cat.class_id, source="derive"))
        created += 1
        task.progress = i + 1

    task.result = {"created": created}
    if log:
        log(f"派生分类素材: {created} 张")
    db.commit()
