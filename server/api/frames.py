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
from sqlalchemy.orm import Session, selectinload

from server.api.deps import get_optional_actor
from server.api.schemas import (
    AnnotationsUpdate,
    BatchFrameFeedback,
    FrameFeedback,
    FrameOut,
    FramePage,
    LabelEstimate,
)
from server.core.audit import record_audit
from server.core.paths import cache_dir, label_path_for_frame
from server.core.review import is_infra_review_note, scrub_infra_review_notes
from server.core.visualize import (
    clear_frame_preview_cache,
    ensure_frame_preview,
    frame_preview_cache_path,
)
from server.core.vlm_profiles import resolve_profile
from server.core.yolo_io import YoloLabel, write_labels
from server.db.database import get_db
from server.db.models import Annotation, Category, Frame, FrameStatus, Project
from server.repositories.material_repository import active_frame_filter

_PREVIEW_CACHE_HEADERS = {"Cache-Control": "private, max-age=3600"}

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
    note = frame.review_note or ""
    return FrameOut(
        id=frame.id,
        filename=frame.filename,
        split=frame.split,
        status=frame.status,
        note=frame.note,
        review_note="" if is_infra_review_note(note) else note,
        source=frame.source,
        uncertainty=frame.uncertainty,
        video_id=frame.video_id,
        material_batch_id=frame.material_batch_id,
        ingest_origin=(
            frame.material_batch.origin.value
            if frame.material_batch and hasattr(frame.material_batch.origin, "value")
            else str(frame.material_batch.origin)
            if frame.material_batch
            else "legacy"
        ),
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
    public_import_id: str | None = None,
    sort: str = Query("uncertainty"),
    limit: int = Query(0, ge=0, le=200),
    db: Session = Depends(get_db),
):
    q = db.query(Frame).options(selectinload(Frame.material_batch)).filter(
        Frame.project_id == project_id,
        active_frame_filter(),
    )
    if status and status != "all":
        q = q.filter(Frame.status == FrameStatus(status))
    if split:
        q = q.filter(Frame.split == split)
    if public_import_id:
        q = q.filter(Frame.public_import_id == public_import_id)
    if sort == "recent":
        q = q.order_by(Frame.updated_at.desc())
    elif sort == "uncertainty":
        q = q.order_by(Frame.uncertainty.desc(), Frame.created_at)
    else:
        q = q.order_by(Frame.created_at)
    if limit:
        q = q.limit(limit)
    frames = q.all()
    scrub_infra_review_notes(db, frames)
    return [_frame_out(f) for f in frames]


@router.get("/frames/page", response_model=FramePage)
def list_frames_page(
    project_id: str,
    statuses: str | None = Query(None),
    split: str | None = Query(None),
    public_import_id: str | None = None,
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

    q = db.query(Frame).options(selectinload(Frame.material_batch)).filter(
        Frame.project_id == project_id,
        active_frame_filter(),
    )
    if parsed_statuses:
        q = q.filter(Frame.status.in_(parsed_statuses))
    if split:
        q = q.filter(Frame.split == split)
    if public_import_id:
        q = q.filter(Frame.public_import_id == public_import_id)
    total = q.count()

    if cursor:
        data = _decode_cursor(cursor)
        expected = {
            "statuses": list(status_values),
            "split": split,
            "public_import_id": public_import_id,
            "sort": sort,
        }
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
    scrub_infra_review_notes(db, rows)
    next_cursor = None
    if has_more and rows:
        last = rows[-1]
        payload = {
            "statuses": list(status_values),
            "split": split,
            "public_import_id": public_import_id,
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
        .filter(Frame.project_id == project_id, active_frame_filter())
        .group_by(Frame.status)
        .all()
    )
    counts["total"] = sum(count for _, count in rows)
    for status, count in rows:
        counts[status.value] = count
    return counts


@router.get("/frames/{frame_id}/image")
def frame_image(
    project_id: str,
    frame_id: str,
    annotated: bool = False,
    max_edge: int | None = Query(default=None, ge=64, le=2048),
    db: Session = Depends(get_db),
):
    frame = db.get(Frame, frame_id)
    if not frame or frame.project_id != project_id:
        raise HTTPException(404, "Frame not found")
    path = Path(frame.filepath)
    if not path.exists():
        raise HTTPException(404, "Image file missing")

    # 主画布原图：直出文件，避免额外编解码
    if not annotated and not max_edge:
        return FileResponse(path)

    want_boxes = bool(annotated and frame.annotations)
    preview_root = cache_dir(project_id) / "preview"
    cache_path = frame_preview_cache_path(
        preview_root,
        frame_id,
        annotated=want_boxes,
        max_edge=max_edge,
    )
    categories = (
        db.query(Category).filter(Category.project_id == project_id).all()
        if want_boxes
        else []
    )
    label_path = label_path_for_frame(project_id, frame) if want_boxes else None
    try:
        ensure_frame_preview(
            categories,
            path,
            label_path,
            cache_path,
            annotated=want_boxes,
            max_edge=max_edge,
            quality=78 if max_edge else 88,
        )
    except ValueError as error:
        raise HTTPException(404, "Image file missing") from error
    return FileResponse(cache_path, media_type="image/jpeg", headers=_PREVIEW_CACHE_HEADERS)


# 允许一键确认为人工确认的来源状态（不含 unlabeled / 已确认）
_BATCH_CONFIRM_FROM = frozenset(
    {
        FrameStatus.NEEDS_HUMAN,
        FrameStatus.LLM_LABELED,
        FrameStatus.AUTO_FIXED,
        FrameStatus.HUMAN_WRONG,
        FrameStatus.AUTO_OK,
    }
)


@router.post("/frames/{frame_id}/feedback")
def frame_feedback(
    project_id: str,
    frame_id: str,
    body: FrameFeedback,
    db: Session = Depends(get_db),
    actor: str = Depends(get_optional_actor),
):
    frame = db.get(Frame, frame_id)
    if not frame or frame.project_id != project_id:
        raise HTTPException(404, "Frame not found")
    frame.status = body.status
    frame.note = body.note
    frame.source = "human"
    db.commit()
    record_audit(
        db,
        actor=actor,
        action="frame.feedback",
        resource_type="frame",
        resource_id=frame_id,
        project_id=project_id,
        summary=f"更新帧复核状态：{body.status.value if hasattr(body.status, 'value') else body.status}",
        metadata={"note": body.note},
    )
    return {"ok": True}


@router.post("/frames/batch-feedback")
def batch_frame_feedback(
    project_id: str,
    body: BatchFrameFeedback,
    db: Session = Depends(get_db),
    actor: str = Depends(get_optional_actor),
):
    """批量将当前筛选来源状态的帧标为人工确认，保留现有标注。"""
    if body.status != FrameStatus.HUMAN_OK:
        raise HTTPException(400, "批量操作仅支持确认为 human_ok")
    if not db.get(Project, project_id):
        raise HTTPException(404, "Project not found")

    from_statuses = []
    for status in body.from_statuses:
        if status not in _BATCH_CONFIRM_FROM:
            raise HTTPException(400, f"不允许从来源状态批量确认：{status.value}")
        from_statuses.append(status)

    query = db.query(Frame).filter(
        Frame.project_id == project_id,
        Frame.status.in_(from_statuses),
        active_frame_filter(),
    )
    if body.public_import_id:
        query = query.filter(Frame.public_import_id == body.public_import_id)

    updated = (
        query.update(
            {
                Frame.status: FrameStatus.HUMAN_OK,
                Frame.source: "human",
                Frame.review_note: "",
            },
            synchronize_session=False,
        )
    )
    db.commit()
    record_audit(
        db,
        actor=actor,
        action="frame.batch_feedback",
        resource_type="project",
        resource_id=project_id,
        project_id=project_id,
        summary=f"一键确认 {updated} 张帧",
        metadata={
            "from_statuses": [s.value for s in from_statuses],
            "status": FrameStatus.HUMAN_OK.value,
            "public_import_id": body.public_import_id,
            "updated": updated,
        },
    )
    return {"ok": True, "updated": updated}


@router.put("/frames/{frame_id}/annotations")
def update_annotations(
    project_id: str,
    frame_id: str,
    body: AnnotationsUpdate,
    db: Session = Depends(get_db),
    actor: str = Depends(get_optional_actor),
):
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

    clear_frame_preview_cache(cache_dir(project_id) / "preview", frame_id)

    frame.status = body.status
    frame.source = "human"
    db.commit()
    record_audit(
        db,
        actor=actor,
        action="frame.annotate",
        resource_type="frame",
        resource_id=frame_id,
        project_id=project_id,
        summary=f"保存帧标注：{len(validated)} 个目标",
        metadata={"status": body.status.value if hasattr(body.status, "value") else body.status, "annotation_count": len(validated)},
    )
    return {"ok": True}


@router.get("/label/estimate", response_model=LabelEstimate)
def label_estimate(
    project_id: str,
    vlm_profile_id: str | None = Query(default=None),
    db: Session = Depends(get_db),
):
    count = (
        db.query(Frame)
        .filter(
            Frame.project_id == project_id,
            active_frame_filter(),
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
    profile = resolve_profile(vlm_profile_id)
    cost = profile.cost_per_image
    return LabelEstimate(frame_count=count, cost_per_image=cost, estimated_cost=round(count * cost, 2))
