"""Windows 中文路径下的图片读写回归测试。"""

from __future__ import annotations

import numpy as np

from server.core.image_io import read_image_bgr, write_image_bgr


def test_read_write_roundtrip_with_unicode_directory(tmp_path):
    unicode_dir = tmp_path / "中文目录"
    unicode_dir.mkdir()
    image_path = unicode_dir / "sample.jpg"
    source = np.full((32, 48, 3), (10, 20, 30), dtype=np.uint8)

    write_image_bgr(image_path, source, quality=92)
    loaded = read_image_bgr(image_path)

    assert loaded is not None
    assert loaded.shape == source.shape
    assert loaded.mean() > 0
