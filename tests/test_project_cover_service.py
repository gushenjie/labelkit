from __future__ import annotations

import cv2
import numpy as np
import pytest

from server.services.project_cover_service import (
    PROJECT_COVER_MAX_BYTES,
    PROJECT_COVER_SIZE,
    ProjectCoverService,
)


def _png_bytes(width: int = 320, height: int = 180) -> bytes:
    image = np.full((height, width, 3), (143, 168, 18), dtype=np.uint8)
    encoded, payload = cv2.imencode(".png", image)
    assert encoded
    return payload.tobytes()


def test_project_cover_is_center_cropped_and_normalized(monkeypatch, tmp_path):
    monkeypatch.setattr(
        "server.services.project_cover_service.project_dir",
        lambda _project_id: tmp_path,
    )
    service = ProjectCoverService()

    cover = service.save_cover("project", "sample.png", _png_bytes())

    saved = cv2.imread(str(cover.path))
    assert saved is not None
    assert (saved.shape[1], saved.shape[0]) == PROJECT_COVER_SIZE
    assert service.has_cover("project")


def _cover_service(monkeypatch, tmp_path) -> ProjectCoverService:
    monkeypatch.setattr(
        "server.services.project_cover_service.project_dir",
        lambda _project_id: tmp_path,
    )
    return ProjectCoverService()


def test_project_cover_rejects_unsupported_extension(monkeypatch, tmp_path):
    service = _cover_service(monkeypatch, tmp_path)

    with pytest.raises(ValueError, match="仅支持"):
        service.save_cover("project", "sample.gif", _png_bytes())


def test_project_cover_rejects_invalid_image_content(monkeypatch, tmp_path):
    service = _cover_service(monkeypatch, tmp_path)

    with pytest.raises(ValueError, match="不是可读取的图片"):
        service.save_cover("project", "sample.png", b"not-an-image")


def test_project_cover_rejects_oversized_upload(monkeypatch, tmp_path):
    service = _cover_service(monkeypatch, tmp_path)

    with pytest.raises(ValueError, match="不能超过 5 MB"):
        service.save_cover("project", "sample.png", b"x" * (PROJECT_COVER_MAX_BYTES + 1))
