"""YOLO label I/O."""

from __future__ import annotations

from pathlib import Path
from typing import TypeAlias


YoloLabel: TypeAlias = tuple[int, float, float, float, float]


def parse_labels(text: str) -> list[YoloLabel]:
    """Parse every YOLO row, including repeated class IDs."""
    result: list[YoloLabel] = []
    for line in text.strip().splitlines():
        parts = line.split()
        if len(parts) < 5:
            continue
        cls_id = int(parts[0])
        xc, yc, w, h = map(float, parts[1:5])
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
