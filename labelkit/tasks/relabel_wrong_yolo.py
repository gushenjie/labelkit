"""YOLO relabel human_wrong frames only; keep status for UI review."""

from __future__ import annotations

import cv2

from labelkit.backends import boxes_to_yolo_labels, get_backend
from labelkit.config import ProjectConfig
from labelkit.datasets import list_frames
from labelkit.rules import check_rules
from labelkit.store import FrameStatus, StateStore
from labelkit.yolo_io import write_labels


def run_relabel_wrong_yolo(
    config: ProjectConfig,
    store: StateStore,
    *,
    backend_name: str = "yolo",
    only: str | None = None,
    limit: int = 0,
) -> dict[str, int]:
    backend = get_backend(config, backend_name)
    frames = list_frames(config, store, status=FrameStatus.HUMAN_WRONG)
    if only:
        frames = [f for f in frames if f.stem.startswith(only)]
    if limit:
        frames = frames[:limit]

    ok = fail = 0
    for frame in frames:
        try:
            img = cv2.imread(str(frame.image_path))
            if img is None:
                fail += 1
                continue
            ih, iw = img.shape[:2]
            boxes = backend.propose(frame.image_path)
            yolo_boxes = boxes_to_yolo_labels(boxes, iw, ih)
            if not any(label[0] == 0 for label in yolo_boxes):
                store.update(
                    frame.id,
                    FrameStatus.HUMAN_WRONG,
                    note="yolo v1: missing bucket",
                    review_note="YOLO v1 重标失败：未检出桶",
                    source="yolo",
                )
                fail += 1
                continue
            write_labels(frame.label_path, yolo_boxes)
            rule = check_rules(config, yolo_boxes, iw, ih)
            issues = "; ".join(rule.issues) if rule.issues else ""
            store.update(
                frame.id,
                FrameStatus.HUMAN_WRONG,
                note=issues or "yolo v1 relabeled",
                review_note="YOLO v1 重标，待人工确认（Y/N）",
                source="yolo",
            )
            ok += 1
        except Exception as e:
            store.update(
                frame.id,
                FrameStatus.HUMAN_WRONG,
                note=str(e),
                review_note="YOLO v1 重标异常",
                source="yolo",
            )
            fail += 1
    store.save()
    return {"ok": ok, "fail": fail, "total": len(frames)}
