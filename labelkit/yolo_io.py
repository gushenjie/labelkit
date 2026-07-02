"""YOLO annotation I/O."""

from __future__ import annotations

from pathlib import Path


def yolo_line(cls_id: int, cx: float, cy: float, w: float, h: float) -> str:
    return f"{cls_id} {cx:.6f} {cy:.6f} {w:.6f} {h:.6f}\n"


def xywh_to_yolo(x: int, y: int, w: int, h: int, iw: int, ih: int) -> tuple[float, float, float, float]:
    return (x + w / 2) / iw, (y + h / 2) / ih, w / iw, h / ih


def yolo_to_xywh(cx: float, cy: float, w: float, h: float, iw: int, ih: int) -> tuple[int, int, int, int]:
    x = int((cx - w / 2) * iw)
    y = int((cy - h / 2) * ih)
    bw, bh = int(w * iw), int(h * ih)
    return x, y, bw, bh


def parse_labels(text: str) -> dict[int, tuple[float, float, float, float]]:
    out: dict[int, tuple[float, float, float, float]] = {}
    for line in text.strip().splitlines():
        p = line.split()
        if len(p) >= 5:
            out[int(p[0])] = tuple(map(float, p[1:5]))
    return out


def write_labels(lbl_path: Path, boxes: dict[int, tuple[float, float, float, float]]) -> None:
    lbl_path.parent.mkdir(parents=True, exist_ok=True)
    lines = [yolo_line(k, *boxes[k]) for k in sorted(boxes)]
    lbl_path.write_text("".join(lines), encoding="utf-8")


def boxes_to_yolo(
    boxes: dict[int, tuple[int, int, int, int]], iw: int, ih: int
) -> dict[int, tuple[float, float, float, float]]:
    return {cls_id: xywh_to_yolo(*xywh, iw, ih) for cls_id, xywh in boxes.items()}
