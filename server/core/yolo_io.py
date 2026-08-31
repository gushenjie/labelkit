"""YOLO label I/O."""

from __future__ import annotations

from pathlib import Path
from typing import TypeAlias


YoloLabel: TypeAlias = tuple[int, float, float, float, float]


def _polygon_to_yolo(parts: list[str]) -> tuple[float, float, float, float]:
    coords = [float(value) for value in parts[1:]]
    if len(coords) < 4 or len(coords) % 2 != 0:
        raise ValueError("polygon 坐标无效")
    xs = coords[0::2]
    ys = coords[1::2]
    xmin, xmax = min(xs), max(xs)
    ymin, ymax = min(ys), max(ys)
    width = max(xmax - xmin, 0.0)
    height = max(ymax - ymin, 0.0)
    xc = min(max(xmin + width / 2, 0.0), 1.0)
    yc = min(max(ymin + height / 2, 0.0), 1.0)
    width = min(max(width, 0.0), 1.0)
    height = min(max(height, 0.0), 1.0)
    return xc, yc, width, height


def parse_labels(text: str) -> list[YoloLabel]:
    """Parse YOLO rows; polygon/segmentation rows are converted to bounding boxes."""
    result: list[YoloLabel] = []
    for line in text.strip().splitlines():
        parts = line.split()
        if len(parts) < 5:
            continue
        cls_id = int(parts[0])
        try:
            if len(parts) == 5:
                xc, yc, w, h = map(float, parts[1:5])
            else:
                xc, yc, w, h = _polygon_to_yolo(parts)
        except ValueError:
            continue
        result.append((cls_id, xc, yc, w, h))
    return result


def write_labels(path: Path, labels: list[YoloLabel]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    lines: list[str] = []
    for cls_id, xc, yc, w, h in labels:
        lines.append(f"{cls_id} {xc:.6f} {yc:.6f} {w:.6f} {h:.6f}")
    path.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")


def xywh_to_yolo(x: int, y: int, w: int, h: int, iw: int, ih: int) -> tuple[float, float, float, float]:
    xc = (x + w / 2) / iw
    yc = (y + h / 2) / ih
    return xc, yc, w / iw, h / ih


def yolo_to_xywh(xc: float, yc: float, w: float, h: float, iw: int, ih: int) -> tuple[int, int, int, int]:
    bw = int(w * iw)
    bh = int(h * ih)
    bx = int(xc * iw - bw / 2)
    by = int(yc * ih - bh / 2)
    return bx, by, bw, bh
