"""YOLO semi-auto labeling with project or uploaded .pt models."""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path

import cv2
from sqlalchemy.orm import Session

from server.core.labeling import boxes_to_yolo_labels, propose_yolo
from server.core.paths import label_path_for_frame
from server.core.yolo_io import YoloLabel, write_labels
from server.db.models import Annotation, Frame, FrameStatus, ModelVersion, Project, Task

PENDING_STATUSES = {
    FrameStatus.LLM_LABELED,
    FrameStatus.AUTO_OK,
    FrameStatus.NEEDS_HUMAN,
    FrameStatus.AUTO_FIXED,
}


def _resolve_model_path(db: Session, project_id: str, model_id: str | None) -> Path:
    if model_id:
        mv = db.get(ModelVersion, model_id)
        if not mv or mv.project_id != project_id:
            raise RuntimeError("模型不存在")
        path = Path(mv.filepath)
    else:
        mv = (
            db.query(ModelVersion)
            .filter(ModelVersion.project_id == project_id)
            .order_by(ModelVersion.version.desc())
            .first()
        )
        path = Path(mv.filepath) if mv else Path()
    if not path.exists():
        raise RuntimeError("模型文件不存在，请先上传 .pt 或完成训练")
    return path


def _resolve_frames(db: Session, project: Project, only_status: str) -> list[Frame]:
    q = db.query(Frame).filter(Frame.project_id == project.id)
    if only_status == "pending":
        q = q.filter(Frame.status.in_(PENDING_STATUSES))
    elif only_status == "human_wrong":
        q = q.filter(Frame.status == FrameStatus.HUMAN_WRONG)
    elif only_status == "unlabeled":
        q = q.filter(Frame.status == FrameStatus.UNLABELED)
    else:
        try:
            q = q.filter(Frame.status == FrameStatus(only_status))
        except ValueError:
            q = q.filter(Frame.status == FrameStatus.HUMAN_WRONG)
    return q.order_by(Frame.uncertainty.desc(), Frame.created_at).all()


def _apply_yolo_result(
    db: Session,
    frame: Frame,
    project: Project,
    boxes: list,
    yolo_labels: list[YoloLabel],
    *,
    was_unlabeled: bool,
) -> None:
    lbl_path = label_path_for_frame(project.id, frame)
    db.query(Annotation).filter(Annotation.frame_id == frame.id).delete()

    if yolo_labels:
        write_labels(lbl_path, yolo_labels)
        ordered_boxes = sorted(boxes, key=lambda item: -item.conf)
        for box, (cls_id, xc, yc, w, h) in zip(ordered_boxes, yolo_labels, strict=True):
            db.add(Annotation(
                frame_id=frame.id,
                class_id=cls_id,
                x_center=xc,
                y_center=yc,
                width=w,
                height=h,
                confidence=box.conf,
                source="yolo",
            ))
        frame.status = FrameStatus.LLM_LABELED
        frame.note = "yolo labeled"
        frame.review_note = "YOLO 预标，待人工确认"
        frame.uncertainty = 1.0 - max((b.conf for b in boxes), default=0.5)
    else:
        lbl_path.write_text("", encoding="utf-8")
        if was_unlabeled:
            frame.status = FrameStatus.NO_TARGET
            frame.note = "yolo: no detection"
            frame.review_note = ""
        else:
            frame.status = FrameStatus.HUMAN_WRONG
            frame.note = "yolo: no detection"
            frame.review_note = "YOLO 未检出，请手动画框"
        frame.uncertainty = 0.8

    frame.source = "yolo"
    frame.updated_at = datetime.now(timezone.utc)


def run_relabel_task(db: Session, task: Task, *, cancelled: Callable[[], bool] | None = None) -> None:
    project = db.get(Project, task.project_id)
    model_path = _resolve_model_path(db, project.id, task.params.get("model_id"))
    conf = float(task.params.get("conf", 0.25))
    only_status = task.params.get("only_status", "human_wrong")

    frames = _resolve_frames(db, project, only_status)
    task.total = len(frames)
    db.commit()

    if task.total == 0:
        task.result = {"ok": 0, "fail": 0, "message": "没有匹配的图片"}
        db.commit()
        return

    ok = fail = 0
    for i, frame in enumerate(frames):
        if cancelled and cancelled():
            break
        was_unlabeled = frame.status == FrameStatus.UNLABELED
        try:
            img = cv2.imread(frame.filepath)
            if img is None:
                fail += 1
                continue
            ih, iw = img.shape[:2]
            boxes = propose_yolo(model_path, Path(frame.filepath), conf=conf)
            yolo_labels = boxes_to_yolo_labels(boxes, iw, ih)
            _apply_yolo_result(db, frame, project, boxes, yolo_labels, was_unlabeled=was_unlabeled)
            ok += 1
        except Exception as e:
            frame.note = str(e)
            fail += 1

        task.progress = i + 1
        if i % 5 == 0:
            db.commit()

    task.result = {"ok": ok, "fail": fail, "only_status": only_status}
    db.commit()
