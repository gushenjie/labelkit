"""Label task runner."""

from __future__ import annotations

from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy.orm import Session

from server.config import settings
from server.core.image_io import read_image_bgr
from server.core.labeling import (
    boxes_to_yolo_labels,
    propose_classify,
    propose_detect,
)
from server.core.paths import label_path_for_frame
from server.core.yolo_io import write_labels
from server.db.models import Annotation, Category, Frame, FrameStatus, Project, ProjectTaskType, Task


CONFIRMED = {FrameStatus.AUTO_OK, FrameStatus.AUTO_FIXED, FrameStatus.HUMAN_OK, FrameStatus.NO_TARGET}

LLM_PENDING_STATUSES = {
    FrameStatus.LLM_LABELED,
    FrameStatus.AUTO_OK,
    FrameStatus.NEEDS_HUMAN,
    FrameStatus.AUTO_FIXED,
}


@dataclass(frozen=True)
class LabelProjectInput:
    id: str
    name: str
    description: str
    task_type: ProjectTaskType
    label_prompt: str


@dataclass(frozen=True)
class LabelCategoryInput:
    class_id: int
    name: str
    description: str
    required: bool


@dataclass(frozen=True)
class LabelFrameInput:
    id: str
    filepath: Path


def _resolve_label_frames(
    db: Session,
    project_id: str,
    only_status: str,
    *,
    force: bool,
    frame_ids: list[str] | None = None,
) -> list[Frame]:
    q = db.query(Frame).filter(Frame.project_id == project_id)
    if frame_ids is not None:
        if not frame_ids:
            return []
        q = q.filter(Frame.id.in_(frame_ids))
    if not force:
        q = q.filter(~Frame.status.in_(CONFIRMED))
    if only_status == "pending":
        q = q.filter(Frame.status.in_(LLM_PENDING_STATUSES))
    elif only_status == FrameStatus.UNLABELED.value:
        # 读取失败会落在 NEEDS_HUMAN 且无标注，允许再次发起 LLM 标注重试。
        q = q.filter(
            (Frame.status == FrameStatus.UNLABELED)
            | (
                (Frame.status == FrameStatus.NEEDS_HUMAN)
                & ~Frame.annotations.any()
            )
        )
    elif only_status:
        q = q.filter(Frame.status == FrameStatus(only_status))
    return q.order_by(Frame.uncertainty.desc(), Frame.created_at).all()


def run_label_task(db: Session, task: Task, *, is_cancelled: Callable[[], bool] | None = None) -> None:
    project = db.get(Project, task.project_id)
    categories = db.query(Category).filter(Category.project_id == project.id).order_by(Category.class_id).all()
    only_status = task.params.get("only_status", FrameStatus.UNLABELED.value)
    force = bool(task.params.get("force", False))
    limit = int(task.params.get("limit", 0))

    frame_ids = task.params.get("frame_ids")
    frames = _resolve_label_frames(
        db,
        project.id,
        only_status,
        force=force,
        frame_ids=list(frame_ids) if frame_ids is not None else None,
    )
    if limit:
        frames = frames[:limit]

    task.total = len(frames)
    db.commit()
    project_input = LabelProjectInput(
        id=project.id,
        name=project.name,
        description=project.description,
        task_type=project.task_type,
        label_prompt=project.label_prompt,
    )
    category_inputs = [
        LabelCategoryInput(
            class_id=category.class_id,
            name=category.name,
            description=category.description,
            required=category.required,
        )
        for category in categories
    ]
    frame_inputs = {
        frame.id: LabelFrameInput(id=frame.id, filepath=Path(frame.filepath))
        for frame in frames
    }

    ok = fail = 0
    stopped = False

    def propose(frame: LabelFrameInput):
        img_path = frame.filepath
        if not img_path.exists():
            raise RuntimeError(f"Image file missing: {img_path}")
        if project_input.task_type == ProjectTaskType.CLASSIFY:
            return ("classify", propose_classify(project_input, category_inputs, img_path))
        img = read_image_bgr(img_path)
        if img is None:
            raise RuntimeError(f"Cannot read image: {img_path}")
        ih, iw = img.shape[:2]
        boxes, note = propose_detect(project_input, category_inputs, img_path)
        return ("detect", (boxes, note, iw, ih))

    concurrency = max(1, min(settings.vlm_max_concurrency, 16))
    for batch_start in range(0, len(frames), concurrency):
        if is_cancelled and is_cancelled():
            stopped = True
            break
        batch = frames[batch_start : batch_start + concurrency]
        proposals: dict[str, tuple | Exception] = {}
        with ThreadPoolExecutor(max_workers=concurrency, thread_name_prefix="labelkit-vlm") as executor:
            futures = {
                executor.submit(propose, frame_inputs[frame.id]): frame.id
                for frame in batch
            }
            for future in as_completed(futures):
                frame_id = futures[future]
                try:
                    proposals[frame_id] = future.result()
                except Exception as error:
                    proposals[frame_id] = error

        for offset, frame in enumerate(batch):
            if is_cancelled and is_cancelled():
                stopped = True
                break
            proposal = proposals[frame.id]
            try:
                if isinstance(proposal, Exception):
                    raise proposal
                proposal_type, payload = proposal
                if proposal_type == "classify":
                    cls_id, conf, note = payload
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
                    boxes, note, iw, ih = payload
                    yolo_labels = boxes_to_yolo_labels(boxes, iw, ih)
                    lbl_path = label_path_for_frame(project.id, frame)
                    if yolo_labels:
                        write_labels(lbl_path, yolo_labels)
                        db.query(Annotation).filter(Annotation.frame_id == frame.id).delete()
                        ordered_boxes = sorted(boxes, key=lambda item: -item.conf)
                        for box, (cls_id, xc, yc, w, h) in zip(ordered_boxes, yolo_labels, strict=True):
                            db.add(Annotation(
                                frame_id=frame.id, class_id=cls_id,
                                x_center=xc, y_center=yc, width=w, height=h,
                                confidence=box.conf, source="vlm",
                            ))
                        frame.status = FrameStatus.LLM_LABELED
                    else:
                        lbl_path.write_text("", encoding="utf-8")
                        frame.status = FrameStatus.NO_TARGET
                    frame.note = note
                    frame.uncertainty = 0.5 if yolo_labels else 0.8

                frame.source = "vlm"
                frame.review_note = "LLM 预标，待人工确认"
                frame.updated_at = datetime.now(timezone.utc)
                ok += 1
            except Exception as error:
                frame.status = FrameStatus.NEEDS_HUMAN
                frame.note = str(error)
                frame.updated_at = datetime.now(timezone.utc)
                fail += 1

            task.progress = batch_start + offset + 1
        db.commit()
        if stopped:
            break

    task.result = {"ok": ok, "fail": fail, "stopped": stopped}
    summary = f"LLM 标注完成: 成功 {ok} 张, 失败 {fail} 张"
    if stopped:
        summary += "（用户中断）"
    task.log = (task.log + "\n" + summary).strip() if task.log else summary
    db.commit()
