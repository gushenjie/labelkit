"""OpenCV 媒体读写（兼容 Windows 中文路径）。"""

from __future__ import annotations

import tempfile
from pathlib import Path

import cv2
import numpy as np


def read_image_bgr(path: Path | str):
    """读取 BGR 图片；优先用 fromfile+imdecode，避免中文路径下 imread 失败。"""
    image_path = Path(path)
    try:
        buffer = np.fromfile(str(image_path), dtype=np.uint8)
        if buffer.size:
            image = cv2.imdecode(buffer, cv2.IMREAD_COLOR)
            if image is not None and image.size > 0:
                return image
    except OSError:
        pass
    return cv2.imread(str(image_path))


def write_image_bgr(path: Path | str, image, *, quality: int = 92) -> None:
    """写入 BGR 图片；使用 imencode+tofile，兼容中文路径。"""
    image_path = Path(path)
    image_path.parent.mkdir(parents=True, exist_ok=True)
    suffix = image_path.suffix.lower()
    if suffix in {".jpg", ".jpeg"}:
        params = [cv2.IMWRITE_JPEG_QUALITY, quality]
        ext = ".jpg"
    elif suffix == ".png":
        params = [cv2.IMWRITE_PNG_COMPRESSION, 3]
        ext = ".png"
    else:
        params = []
        ext = suffix or ".jpg"
    ok, encoded = cv2.imencode(ext, image, params)
    if not ok:
        raise ValueError(f"无法编码图片: {image_path}")
    encoded.tofile(str(image_path))
    if not image_path.is_file():
        raise ValueError(f"无法写入图片: {image_path}")


def open_video_capture(video_path: Path | str) -> cv2.VideoCapture:
    """打开视频；在 Windows 中文路径下必要时回退到临时 ASCII 路径。"""
    path = Path(video_path)
    cap = cv2.VideoCapture(str(path), cv2.CAP_FFMPEG)
    if cap.isOpened():
        return cap
    cap.release()
    cap = cv2.VideoCapture(str(path))
    if cap.isOpened():
        return cap
    cap.release()

    suffix = path.suffix or ".mp4"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(path.read_bytes())
        tmp_path = tmp.name
    cap = cv2.VideoCapture(tmp_path, cv2.CAP_FFMPEG)
    if not cap.isOpened():
        cap = cv2.VideoCapture(tmp_path)
    if not cap.isOpened():
        Path(tmp_path).unlink(missing_ok=True)
        raise RuntimeError(f"无法打开视频: {path}")
    return cap
