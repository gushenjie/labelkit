"""帧预览缓存命中与缩略图生成。"""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

from server.core.image_io import write_image_bgr
from server.core.visualize import (
    ensure_frame_preview,
    frame_preview_cache_path,
    preview_cache_fresh,
)


def _write_blank(path: Path, size: int = 640) -> None:
    image = np.zeros((size, size, 3), dtype=np.uint8)
    image[:, :] = (40, 120, 80)
    write_image_bgr(path, image, quality=90)


def test_preview_cache_fresh_and_hit(tmp_path: Path):
    image = tmp_path / "frame.jpg"
    label = tmp_path / "frame.txt"
    cache_root = tmp_path / "preview"
    _write_blank(image, 800)
    label.write_text("0 0.5 0.5 0.2 0.2\n", encoding="utf-8")

    cache = frame_preview_cache_path(cache_root, "f1", annotated=True, max_edge=320)
    assert not preview_cache_fresh(cache, image, label)

    first = ensure_frame_preview([], image, label, cache, annotated=True, max_edge=320)
    assert first == cache
    assert cache.is_file()
    cached = cv2.imread(str(cache))
    assert cached is not None
    assert max(cached.shape[:2]) <= 320

    mtime_before = cache.stat().st_mtime
    second = ensure_frame_preview([], image, label, cache, annotated=True, max_edge=320)
    assert second == cache
    assert cache.stat().st_mtime == mtime_before


def test_preview_cache_invalidates_when_label_changes(tmp_path: Path):
    image = tmp_path / "frame.jpg"
    label = tmp_path / "frame.txt"
    cache_root = tmp_path / "preview"
    _write_blank(image, 400)
    label.write_text("0 0.5 0.5 0.1 0.1\n", encoding="utf-8")
    cache = frame_preview_cache_path(cache_root, "f2", annotated=True, max_edge=200)
    ensure_frame_preview([], image, label, cache, annotated=True, max_edge=200)
    older = cache.stat().st_mtime

    label.write_text("0 0.4 0.4 0.3 0.3\n", encoding="utf-8")
    assert not preview_cache_fresh(cache, image, label)
    ensure_frame_preview([], image, label, cache, annotated=True, max_edge=200)
    assert cache.stat().st_mtime >= older
