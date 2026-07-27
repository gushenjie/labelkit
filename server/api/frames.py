"""Frame and annotation API."""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from server.api.schemas import AnnotationsUpdate, FrameFeedback, FrameOut, LabelEstimate
from server.config import settings
from server.core.paths import labels_dir
from server.core.visualize import draw_labeled_image, save_review_image
from server.core.yolo_io import write_labels
from server.db.database import get_db
from server.db.models import Annotation, Category, Frame, FrameStatus, Project

router = APIRouter(prefix="/api/projects/{project_id}", tags=["frames"])


def _frame_out(frame: Frame) -> FrameOut:
    return FrameOut(
        id=frame.id,
        filename=frame.filename,
        split=frame.split,
        status=frame.status,
        note=frame.note,
        review_note=frame.review_note,
        source=frame.source,
        uncertainty=frame.uncertainty,
        video_id=frame.video_id,
        has_labels=bool(frame.annotations) or frame.status == FrameStatus.NO_TARGET,
        annotations=[{
            "id": a.id,
            "class_id": a.class_id,
            "x_center": a.x_center,
            "y_center": a.y_center,
            "width": a.width,
            "height": a.height,
            "confidence": a.confidence,
            "source": a.source,
        } for a in frame.annotations],
        created_at=frame.created_at,
        updated_at=frame.updated_at,
    )


@router.get("/frames", response_model=list[FrameOut])
def list_frames(
    project_id: str,
    status: str | None = Query(None),
    split: str | None = Query(None),
    sort: str = Query("uncertainty"),
    limit: int = Query(0, ge=0, le=200),
    db: Session = Depends(get_db),
):
    q = db.query(Frame).filter(Frame.project_id == project_id)
    if status and status != "all":
        q = q.filter(Frame.status == FrameStatus(status))
    if split:
        q = q.filter(Frame.split == split)
    if sort == "recent":
        q = q.order_by(Frame.updated_at.desc())
    elif sort == "uncertainty":
        q = q.order_by(Frame.uncertainty.desc(), Frame.created_at)
    else:
        q = q.order_by(Frame.created_at)
    if limit:
        q = q.limit(limit)
    frames = q.all()
    return [_frame_out(f) for f in frames]


@router.get("/frames/stats")
def frame_stats(project_id: str, db: Session = Depends(get_db)):
    frames = db.query(Frame).filter(Frame.project_id == project_id).all()
    counts: dict[str, int] = {s.value: 0 for s in FrameStatus}
    counts["total"] = len(frames)
    for f in frames:
        counts[f.status.value] = counts.get(f.status.value, 0) + 1
    return counts


@router.get("/frames/{frame_id}/image")
def frame_image(project_id: str, frame_id: str, annotated: bool = False, db: Session = Depends(get_db)):
    frame = db.get(Frame, frame_id)
    if not frame or frame.project_id != project_id:
        raise HTTPException(404, "Frame not found")
    path = Path(frame.filepath)
    if not path.exists():
        raise HTTPException(404, "Image file missing")
    if annotated and frame.annotations:
        categories = db.query(Category).filter(Category.project_id == project_id).all()
        lbl_path = labels_dir(project_id, frame.split) / f"{path.stem}.txt"
        import cv2
        from server.core.paths import cache_dir
        cache = cache_dir(project_id) / "preview" / f"{frame_id}.jpg"
        cache.parent.mkdir(parents=True, exist_ok=True)
        img = draw_labeled_image(categories, path, lbl_path)
        cv2.imwrite(str(cache), img, [cv2.IMWRITE_JPEG_QUALITY, 92])
        return FileResponse(cache)
    return FileResponse(path)


@router.post("/frames/{frame_id}/feedback")
def frame_feedback(project_id: str, frame_id: str, body: FrameFeedback, db: Session = Depends(get_db)):
    frame = db.get(Frame, frame_id)
    if not frame or frame.project_id != project_id:
        raise HTTPException(404, "Frame not found")
    frame.status = body.status
    frame.note = body.note
    frame.source = "human"
    db.commit()
    return {"ok": True}


@router.put("/frames/{frame_id}/annotations")
def update_annotations(project_id: str, frame_id: str, body: AnnotationsUpdate, db: Session = Depends(get_db)):
    frame = db.get(Frame, frame_id)
    if not frame or frame.project_id != project_id:
        raise HTTPException(404, "Frame not found")

    db.query(Annotation).filter(Annotation.frame_id == frame_id).delete()
    yolo_boxes: dict[int, tuple[float, float, float, float]] = {}
    for ann in body.annotations:
        cls_id = int(ann["class_id"])
        if "x_center" in ann:
            xc, yc, w, h = float(ann["x_center"]), float(ann["y_center"]), float(ann["width"]), float(ann["height"])
            db.add(Annotation(
                frame_id=frame_id, class_id=cls_id,
                x_center=xc, y_center=yc, width=w, height=h,
                confidence=float(ann.get("confidence", 1.0)),
                source="manual",
            ))
            yolo_boxes[cls_id] = (xc, yc, w, h)
        else:
            db.add(Annotation(frame_id=frame_id, class_id=cls_id, source="manual"))

    project = db.get(Project, project_id)
    if project and project.task_type.value == "detect":
        lbl_path = labels_dir(project_id, frame.split) / f"{Path(frame.filename).stem}.txt"
        write_labels(lbl_path, yolo_boxes)

    frame.status = body.status
    frame.source = "human"
    db.commit()
    return {"ok": True}


@router.get("/label/estimate", response_model=LabelEstimate)
def label_estimate(project_id: str, db: Session = Depends(get_db)):
    count = db.query(Frame).filter(
        Frame.project_id == project_id,
        Frame.status == FrameStatus.UNLABELED,
    ).count()
    cost = settings.vlm_cost_per_image
    return LabelEstimate(frame_count=count, cost_per_image=cost, estimated_cost=round(count * cost, 2))
