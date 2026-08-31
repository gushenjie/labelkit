"""Frame and annotation API."""

from __future__ import annotations

import base64
import json
from datetime import datetime
import math
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session

from server.api.schemas import AnnotationsUpdate, FrameFeedback, FrameOut, FramePage, LabelEstimate
from server.config import settings
from server.core.paths import label_path_for_frame
from server.core.visualize import draw_labeled_image, save_review_image
from server.core.yolo_io import YoloLabel, write_labels
from server.db.database import get_db
from server.db.models import Annotation, Category, Frame, FrameStatus, Project

router = APIRouter(prefix="/api/projects/{project_id}", tags=["frames"])


def _encode_cursor(payload: dict) -> str:
    raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _decode_cursor(cursor: str) -> dict:
    try:
        padding = "=" * (-len(cursor) % 4)
        return json.loads(base64.urlsafe_b64decode(cursor + padding))
    except Exception as error:
        raise HTTPException(400, "Invalid frame cursor") from error


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


@router.get("/frames/page", response_model=FramePage)
def list_frames_page(
    project_id: str,
    statuses: str | None = Query(None),
    split: str | None = Query(None),
    sort: str = Query("uncertainty", pattern="^(uncertainty|recent|created)$"),
    cursor: str | None = Query(None),
    limit: int = Query(100, ge=1, le=100),
    db: Session = Depends(get_db),
):
    status_values = tuple(sorted(value for value in (statuses or "").split(",") if value))
    try:
        parsed_statuses = tuple(FrameStatus(value) for value in status_values)
    except ValueError as error:
        raise HTTPException(400, f"Invalid frame status: {error}") from error

    q = db.query(Frame).filter(Frame.project_id == project_id)
    if parsed_statuses:
        q = q.filter(Frame.status.in_(parsed_statuses))
    if split:
        q = q.filter(Frame.split == split)
    total = q.count()

    if cursor:
        data = _decode_cursor(cursor)
        expected = {"statuses": list(status_values), "split": split, "sort": sort}
        if any(data.get(key) != value for key, value in expected.items()):
            raise HTTPException(400, "Frame cursor does not match current filters")
        last_id = data["id"]
        if sort == "uncertainty":
            last_uncertainty = float(data["uncertainty"])
            last_created = datetime.fromisoformat(data["created_at"])
            q = q.filter(
                or_(
                    Frame.uncertainty < last_uncertainty,
                    and_(Frame.uncertainty == last_uncertainty, Frame.created_at > last_created),
                    and_(
                        Frame.uncertainty == last_uncertainty,
                        Frame.created_at == last_created,
                        Frame.id > last_id,
                    ),
                )
            )
        elif sort == "recent":
            last_updated = datetime.fromisoformat(data["updated_at"])
            q = q.filter(
                or_(
                    Frame.updated_at < last_updated,
                    and_(Frame.updated_at == last_updated, Frame.id > last_id),
                )
            )
        else:
            last_created = datetime.fromisoformat(data["created_at"])
            q = q.filter(
                or_(
                    Frame.created_at > last_created,
                    and_(Frame.created_at == last_created, Frame.id > last_id),
                )
            )

    if sort == "uncertainty":
        q = q.order_by(Frame.uncertainty.desc(), Frame.created_at.asc(), Frame.id.asc())
    elif sort == "recent":
        q = q.order_by(Frame.updated_at.desc(), Frame.id.asc())
    else:
        q = q.order_by(Frame.created_at.asc(), Frame.id.asc())
    rows = q.limit(limit + 1).all()
    has_more = len(rows) > limit
    rows = rows[:limit]
    next_cursor = None
    if has_more and rows:
        last = rows[-1]
        payload = {
            "statuses": list(status_values),
            "split": split,
            "sort": sort,
            "id": last.id,
            "created_at": last.created_at.isoformat(),
        }
        if sort == "uncertainty":
            payload["uncertainty"] = last.uncertainty
        if sort == "recent":
            payload["updated_at"] = last.updated_at.isoformat()
        next_cursor = _encode_cursor(payload)
    return FramePage(items=[_frame_out(frame) for frame in rows], next_cursor=next_cursor, total=total)


@router.get("/frames/stats")
def frame_stats(project_id: str, db: Session = Depends(get_db)):
    counts: dict[str, int] = {s.value: 0 for s in FrameStatus}
    rows = (
        db.query(Frame.status, func.count(Frame.id))
        .filter(Frame.project_id == project_id)
        .group_by(Frame.status)
        .all()
    )
    counts["total"] = sum(count for _, count in rows)
    for status, count in rows:
        counts[status.value] = count
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
        lbl_path = label_path_for_frame(project_id, frame)
        from server.core.image_io import write_image_bgr
        from server.core.paths import cache_dir
        cache = cache_dir(project_id) / "preview" / f"{frame_id}.jpg"
        img = draw_labeled_image(categories, path, lbl_path)
        write_image_bgr(cache, img, quality=92)
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

    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    valid_class_ids = {
        value for (value,) in db.query(Category.class_id).filter(Category.project_id == project_id).all()
    }

    validated: list[tuple[int, float | None, float | None, float | None, float | None, float]] = []
    for index, ann in enumerate(body.annotations, start=1):
        try:
            cls_id = int(ann["class_id"])
        except (KeyError, TypeError, ValueError) as error:
            raise HTTPException(400, f"第 {index} 个标注缺少有效的 class_id") from error
        if cls_id not in valid_class_ids:
            raise HTTPException(400, f"第 {index} 个标注引用了不存在的类别 ID: {cls_id}")

        bbox_keys = ("x_center", "y_center", "width", "height")
        has_bbox = [key in ann for key in bbox_keys]
        if any(has_bbox) and not all(has_bbox):
            raise HTTPException(400, f"第 {index} 个标注的边界框字段不完整")

        try:
            confidence = float(ann.get("confidence", 1.0))
        except (TypeError, ValueError) as error:
            raise HTTPException(400, f"第 {index} 个标注的置信度不是有效数字") from error
        if not math.isfinite(confidence) or not 0 <= confidence <= 1:
            raise HTTPException(400, f"第 {index} 个标注的置信度必须在 0 到 1 之间")

        if all(has_bbox):
            try:
                xc, yc, width, height = (float(ann[key]) for key in bbox_keys)
            except (TypeError, ValueError) as error:
                raise HTTPException(400, f"第 {index} 个标注的边界框不是有效数字") from error
            values = (xc, yc, width, height)
            if not all(math.isfinite(value) for value in values):
                raise HTTPException(400, f"第 {index} 个标注的边界框包含非有限值")
            if width <= 0 or height <= 0:
                raise HTTPException(400, f"第 {index} 个标注的宽高必须大于 0")
            if xc - width / 2 < 0 or xc + width / 2 > 1 or yc - height / 2 < 0 or yc + height / 2 > 1:
                raise HTTPException(400, f"第 {index} 个标注超出图片边界")
            validated.append((cls_id, xc, yc, width, height, confidence))
        else:
            validated.append((cls_id, None, None, None, None, confidence))

    if project.task_type.value == "detect" and any(item[1] is None for item in validated):
        raise HTTPException(400, "检测项目的标注必须包含完整边界框")
    if project.task_type.value == "classify" and any(item[1] is not None for item in validated):
        raise HTTPException(400, "分类项目的标注不能包含边界框")
    if project.task_type.value == "classify" and len(validated) > 1:
        raise HTTPException(400, "分类项目每帧最多只能选择一个类别")

    # All input is validated before deleting the existing annotations. A rejected
    # save therefore cannot destroy the user's last confirmed result.
    db.query(Annotation).filter(Annotation.frame_id == frame_id).delete()
    yolo_labels: list[YoloLabel] = []
    for cls_id, xc, yc, width, height, confidence in validated:
        if xc is not None and yc is not None and width is not None and height is not None:
            db.add(Annotation(
                frame_id=frame_id, class_id=cls_id,
                x_center=xc, y_center=yc, width=width, height=height,
                confidence=confidence,
                source="manual",
            ))
            yolo_labels.append((cls_id, xc, yc, width, height))
        else:
            db.add(Annotation(frame_id=frame_id, class_id=cls_id, confidence=confidence, source="manual"))

    if project.task_type.value == "detect":
        lbl_path = label_path_for_frame(project_id, frame)
        write_labels(lbl_path, yolo_labels)

    frame.status = body.status
    frame.source = "human"
    db.commit()
    return {"ok": True}


@router.get("/label/estimate", response_model=LabelEstimate)
def label_estimate(project_id: str, db: Session = Depends(get_db)):
    count = (
        db.query(Frame)
        .filter(
            Frame.project_id == project_id,
            or_(
                Frame.status == FrameStatus.UNLABELED,
                and_(
                    Frame.status == FrameStatus.NEEDS_HUMAN,
                    ~Frame.annotations.any(),
                ),
            ),
        )
        .count()
    )
    cost = settings.vlm_cost_per_image
    return LabelEstimate(frame_count=count, cost_per_image=cost, estimated_cost=round(count * cost, 2))
