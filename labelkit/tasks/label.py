"""Auto-labeling task."""

from __future__ import annotations

import os

import cv2

from labelkit.backends import boxes_to_yolo_dict, get_backend
from labelkit.config import ProjectConfig
from labelkit.datasets import iter_target_frames
from labelkit.rules import check_rules
from labelkit.store import FrameStatus, StateStore
from labelkit.yolo_io import write_labels


def run_label(
    config: ProjectConfig,
    store: StateStore,
    *,
    backend_name: str = "vlm",
    only: str | None = None,
    limit: int = 0,
    force: bool = False,
) -> dict[str, int]:
    backend = get_backend(config, backend_name)
    conf_accept = config.yolo.conf_accept if backend_name == "yolo" else 0.0

    if force:
        from labelkit.datasets import list_frames
        frames = list_frames(config, store)
        if only:
            frames = [f for f in frames if f.stem.startswith(only)]
        if limit:
            frames = frames[:limit]
    else:
        frames = iter_target_frames(
            config,
            store,
            only=only,
            limit=limit,
            statuses={FrameStatus.UNLABELED, FrameStatus.NEEDS_HUMAN, FrameStatus.HUMAN_WRONG, FrameStatus.LLM_LABELED},
        )

    ok = skip = fail = 0
    for frame in frames:
        rec = store.get(frame.id)
        if rec and rec.status == FrameStatus.HUMAN_OK and not force:
            skip += 1
            continue
        try:
            img = cv2.imread(str(frame.image_path))
            if img is None:
                fail += 1
                continue
            ih, iw = img.shape[:2]
            boxes = backend.propose(frame.image_path)
            if backend_name == "yolo" and boxes:
                low_conf = any(b.conf < conf_accept for b in boxes)
                has_api = bool(os.environ.get(config.vlm.api_key_env))
                if low_conf and has_api:
                    from labelkit.backends import VlmBackend
                    vlm = VlmBackend(config)
                    boxes = vlm.propose(frame.image_path)

            yolo_boxes = boxes_to_yolo_dict(boxes, iw, ih)
            if 0 not in yolo_boxes:
                store.update(frame.id, FrameStatus.NEEDS_HUMAN, note="missing bucket", source=backend_name)
                fail += 1
                continue
            write_labels(frame.label_path, yolo_boxes)
            rule = check_rules(config, yolo_boxes, iw, ih)
            status = FrameStatus.LLM_LABELED if rule.ok else FrameStatus.NEEDS_HUMAN
            note = "; ".join(rule.issues) if rule.issues else ""
            store.update(frame.id, status, note=note, source=backend_name)
            ok += 1
        except Exception as e:
            store.update(frame.id, FrameStatus.NEEDS_HUMAN, note=str(e), source=backend_name)
            fail += 1
    store.save()
    return {"ok": ok, "skip": skip, "fail": fail}
