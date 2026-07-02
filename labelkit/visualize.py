"""Draw boxes on image for VLM review."""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

from labelkit.config import ProjectConfig
from labelkit.yolo_io import parse_labels, yolo_to_xywh


def draw_labeled_image(
    config: ProjectConfig,
    image_path: Path,
    labels: dict | None = None,
    lbl_path: Path | None = None,
) -> np.ndarray:
    img = cv2.imread(str(image_path))
    if img is None:
        raise ValueError(f"Cannot read {image_path}")
    ih, iw = img.shape[:2]
    if labels is None:
        if lbl_path and lbl_path.exists():
            labels = parse_labels(lbl_path.read_text())
        else:
            labels = {}
    for cls in config.classes:
        if cls.id not in labels:
            continue
        x, y, w, h = yolo_to_xywh(*labels[cls.id], iw, ih)
        color = cls.color
        cv2.rectangle(img, (x, y), (x + w, y + h), color, 3)
        cv2.putText(
            img, cls.name, (x, max(0, y - 8)),
            cv2.FONT_HERSHEY_SIMPLEX, 0.8, color, 2, cv2.LINE_AA,
        )
    return img


def save_review_image(config: ProjectConfig, image_path: Path, lbl_path: Path, out_path: Path) -> Path:
    img = draw_labeled_image(config, image_path, lbl_path=lbl_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(out_path), img, [cv2.IMWRITE_JPEG_QUALITY, 90])
    return out_path
