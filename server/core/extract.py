"""Video frame extraction."""

from __future__ import annotations

from pathlib import Path
from typing import Callable

import cv2


def extract_frames(
    video_path: Path,
    output_dir: Path,
    *,
    target_fps: float = 1.0,
    max_frames: int = 0,
    prefix: str = "frame",
    on_progress: Callable[[int, int], None] | None = None,
) -> list[Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open video: {video_path}")

    native_fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    interval = max(1, int(round(native_fps / max(target_fps, 0.1))))

    saved: list[Path] = []
    idx = 0
    frame_no = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        if frame_no % interval == 0:
            out = output_dir / f"{prefix}_{idx:06d}.jpg"
            cv2.imwrite(str(out), frame, [cv2.IMWRITE_JPEG_QUALITY, 92])
            saved.append(out)
            idx += 1
            if on_progress:
                on_progress(frame_no, total)
            if max_frames and len(saved) >= max_frames:
                break
        frame_no += 1

    cap.release()
    return saved
