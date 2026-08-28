"""YOLO annotation I/O."""

from __future__ import annotations

from pathlib import Path
from typing import TypeAlias

YoloLabel: TypeAlias = tuple[int, float, float, float, float]


def yolo_line(cls_id: int, cx: float, cy: float, w: float, h: float) -> str:
    return f"{cls_id} {cx:.6f} {cy:.6f} {w:.6f} {h:.6f}\n"


def xywh_to_yolo(x: int, y: int, w: int, h: int, iw: int, ih: int) -> tuple[float, float, float, float]:
    return (x + w / 2) / iw, (y + h / 2) / ih, w / iw, h / ih


def yolo_to_xywh(cx: float, cy: float, w: float, h: float, iw: int, ih: int) -> tuple[int, int, int, int]:
    x = int((cx - w / 2) * iw)
    y = int((cy - h / 2) * ih)
    bw, bh = int(w * iw), int(h * ih)
    return x, y, bw, bh


def parse_labels(text: str) -> list[YoloLabel]:
    out: list[YoloLabel] = []
    for line in text.strip().splitlines():
        p = line.split()
        if len(p) >= 5:
            out.append((int(p[0]), *map(float, p[1:5])))
    return out


def write_labels(lbl_path: Path, boxes: list[YoloLabel]) -> None:
    lbl_path.parent.mkdir(parents=True, exist_ok=True)
    lines = [yolo_line(class_id, xc, yc, width, height) for class_id, xc, yc, width, height in boxes]
    lbl_path.write_text("".join(lines), encoding="utf-8")


def boxes_to_yolo(
    boxes: list[tuple[int, int, int, int, int]], iw: int, ih: int
) -> list[YoloLabel]:
    return [(cls_id, *xywh_to_yolo(x, y, w, h, iw, ih)) for cls_id, x, y, w, h in boxes]
