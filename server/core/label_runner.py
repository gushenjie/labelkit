"""Label task runner."""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path

import cv2
from sqlalchemy.orm import Session

from server.core.labeling import (
    boxes_to_yolo_dict,
    propose_classify,
    propose_detect,
)
from server.core.paths import labels_dir
from server.core.yolo_io import write_labels
from server.db.models import Annotation, Category, Frame, FrameStatus, Project, ProjectTaskType, Task


CONFIRMED = {FrameStatus.AUTO_OK, FrameStatus.AUTO_FIXED, FrameStatus.HUMAN_OK, FrameStatus.NO_TARGET}

LLM_PENDING_STATUSES = {
    FrameStatus.LLM_LABELED,
    FrameStatus.AUTO_OK,
    FrameStatus.NEEDS_HUMAN,
    FrameStatus.AUTO_FIXED,
}


def _resolve_label_frames(db: Session, project_id: str, only_status: str, *, force: bool) -> list[Frame]:
    q = db.query(Frame).filter(Frame.project_id == project_id)
    if not force:
        q = q.filter(~Frame.status.in_(CONFIRMED))
    if only_status == "pending":
        q = q.filter(Frame.status.in_(LLM_PENDING_STATUSES))
    elif only_status:
        q = q.filter(Frame.status == FrameStatus(only_status))
    return q.order_by(Frame.uncertainty.desc(), Frame.created_at).all()


def run_label_task(db: Session, task: Task, *, is_cancelled: Callable[[], bool] | None = None) -> None:
    project = db.get(Project, task.project_id)
    categories = db.query(Category).filter(Category.project_id == project.id).order_by(Category.class_id).all()
    only_status = task.params.get("only_status", FrameStatus.UNLABELED.value)
    force = bool(task.params.get("force", False))
    limit = int(task.params.get("limit", 0))

    frames = _resolve_label_frames(db, project.id, only_status, force=force)
    if limit:
        frames = frames[:limit]

    task.total = len(frames)
    db.commit()

    ok = fail = 0
    stopped = False
    for i, frame in enumerate(frames):
        if is_cancelled and is_cancelled():
            stopped = True
            break
        if frame.status == FrameStatus.HUMAN_OK and not force:
            continue
        try:
            img_path = Path(frame.filepath)
            if not img_path.exists():
                fail += 1
                continue

            if project.task_type == ProjectTaskType.CLASSIFY:
                cls_id, conf, note = propose_classify(project, categories, img_path)
                db.query(Annotation).filter(Annotation.frame_id == frame.id).delete()
                if cls_id is None:
                    frame.status = FrameStatus.NO_TARGET
                    frame.note = note
                    frame.uncertainty = 1.0 - conf
                else:
                    db.add(Annotation(frame_id=frame.id, class_id=cls_id, confidence=conf, source="vlm"))
                    frame.status = FrameStatus.LLM_LABELED
                    frame.note = note
                    frame.uncertainty = 1.0 - conf
            else:
                img = cv2.imread(str(img_path))
                ih, iw = img.shape[:2]
                boxes, note = propose_detect(project, categories, img_path)
                yolo_boxes = boxes_to_yolo_dict(boxes, iw, ih)
                lbl_path = labels_dir(project.id, frame.split) / f"{Path(frame.filename).stem}.txt"
                if yolo_boxes:
                    write_labels(lbl_path, yolo_boxes)
                    db.query(Annotation).filter(Annotation.frame_id == frame.id).delete()
                    for cls_id, (xc, yc, w, h) in yolo_boxes.items():
                        db.add(Annotation(
                            frame_id=frame.id, class_id=cls_id,
                            x_center=xc, y_center=yc, width=w, height=h,
                            confidence=0.9, source="vlm",
                        ))
                    frame.status = FrameStatus.LLM_LABELED
                else:
                    lbl_path.write_text("", encoding="utf-8")
                    frame.status = FrameStatus.NO_TARGET
                frame.note = note
                frame.uncertainty = 0.5 if yolo_boxes else 0.8

            frame.source = "vlm"
            frame.review_note = "LLM 预标，待人工确认"
            frame.updated_at = datetime.now(timezone.utc)
            ok += 1
        except Exception as e:
            frame.status = FrameStatus.NEEDS_HUMAN
            frame.note = str(e)
            frame.updated_at = datetime.now(timezone.utc)
            fail += 1

        task.progress = i + 1
        if i % 5 == 0:
            db.commit()

    task.result = {"ok": ok, "fail": fail, "stopped": stopped}
    db.commit()
