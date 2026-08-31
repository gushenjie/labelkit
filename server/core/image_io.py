"""OpenCV 图片读写（兼容 Windows 中文路径）。"""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np


def read_image_bgr(path: Path):
    """读取 BGR 图片；优先用 fromfile+imdecode，避免中文路径下 imread 失败。"""
    try:
        buffer = np.fromfile(str(path), dtype=np.uint8)
        if buffer.size:
            image = cv2.imdecode(buffer, cv2.IMREAD_COLOR)
            if image is not None and image.size > 0:
                return image
    except OSError:
        pass
    return cv2.imread(str(path))


def write_image_bgr(path: Path, image, *, quality: int = 92) -> None:
    """写入 BGR 图片；使用 imencode+tofile，兼容中文路径。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    suffix = path.suffix.lower()
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
        raise ValueError(f"无法编码图片: {path}")
    encoded.tofile(str(path))
