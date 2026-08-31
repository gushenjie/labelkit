"""Draw labeled images for review."""

from __future__ import annotations

from pathlib import Path

import cv2

from server.core.image_io import read_image_bgr, write_image_bgr
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


def _line_thickness(image_height: int, image_width: int) -> int:
    return max(3, min(image_height, image_width) // 180)


def _draw_box(
    img: cv2.Mat,
    x: int,
    y: int,
    bw: int,
    bh: int,
    color: tuple[int, int, int],
    label: str,
) -> None:
    thickness = _line_thickness(img.shape[0], img.shape[1])
    x2, y2 = x + bw, y + bh
    cv2.rectangle(img, (x, y), (x2, y2), (0, 0, 0), thickness + 2)
    cv2.rectangle(img, (x, y), (x2, y2), color, thickness)
    if not label:
        return
    font = cv2.FONT_HERSHEY_SIMPLEX
    scale = max(0.55, min(img.shape[0], img.shape[1]) / 900)
    text_thickness = max(1, thickness - 1)
    (text_w, text_h), baseline = cv2.getTextSize(label, font, scale, text_thickness)
    text_y = max(text_h + 6, y - 4)
    cv2.rectangle(
        img,
        (x, text_y - text_h - 6),
        (x + text_w + 8, text_y + baseline),
        (0, 0, 0),
        -1,
    )
    cv2.putText(img, label, (x + 4, text_y), font, scale, color, text_thickness, cv2.LINE_AA)


def draw_labeled_image(
    categories: list[Category],
    image_path: Path,
    label_path: Path,
) -> cv2.Mat:
    img = read_image_bgr(image_path)
    if img is None:
        raise ValueError(f"Cannot read {image_path}")
    ih, iw = img.shape[:2]
    if label_path.exists():
        labels = parse_labels(label_path.read_text(encoding="utf-8"))
        name_map = {c.class_id: c.name for c in categories}
        for cls_id, xc, yc, w, h in labels:
            x, y, bw, bh = yolo_to_xywh(xc, yc, w, h, iw, ih)
            color = _color_for_class(categories, cls_id)
            name = name_map.get(cls_id, str(cls_id))
            _draw_box(img, x, y, bw, bh, color, name)
    return img


def save_review_image(
    categories: list[Category],
    image_path: Path,
    label_path: Path,
    out_path: Path,
) -> None:
    img = draw_labeled_image(categories, image_path, label_path)
    write_image_bgr(out_path, img, quality=92)
