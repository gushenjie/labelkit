"""Draw labeled images for review."""

from __future__ import annotations

from pathlib import Path

import cv2

from server.core.yolo_io import parse_labels, yolo_to_xywh
from server.db.models import Category


def _color_for_class(categories: list[Category], cls_id: int) -> tuple[int, int, int]:
    for c in categories:
        if c.class_id == cls_id:
            hex_color = c.color.lstrip("#")
            if len(hex_color) == 6:
                r = int(hex_color[0:2], 16)
                g = int(hex_color[2:4], 16)
                b = int(hex_color[4:6], 16)
                return b, g, r
    return 0, 140, 255


def draw_labeled_image(
    categories: list[Category],
    image_path: Path,
    label_path: Path,
) -> cv2.Mat:
    img = cv2.imread(str(image_path))
    if img is None:
        raise ValueError(f"Cannot read {image_path}")
    ih, iw = img.shape[:2]
    if label_path.exists():
        labels = parse_labels(label_path.read_text(encoding="utf-8"))
        name_map = {c.class_id: c.name for c in categories}
        for cls_id, (xc, yc, w, h) in labels.items():
            x, y, bw, bh = yolo_to_xywh(xc, yc, w, h, iw, ih)
            color = _color_for_class(categories, cls_id)
            cv2.rectangle(img, (x, y), (x + bw, y + bh), color, 2)
            name = name_map.get(cls_id, str(cls_id))
            cv2.putText(img, name, (x, max(20, y - 6)), cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)
    return img


def save_review_image(
    categories: list[Category],
    image_path: Path,
    label_path: Path,
    out_path: Path,
) -> None:
    img = draw_labeled_image(categories, image_path, label_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(out_path), img, [cv2.IMWRITE_JPEG_QUALITY, 92])
