"""Project cover image storage and normalization."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import uuid

import cv2
import numpy as np

from server.core.image_io import write_image_bgr
from server.db.database import project_dir

PROJECT_COVER_MAX_BYTES = 5 * 1024 * 1024
PROJECT_COVER_SIZE = (800, 1000)
PROJECT_COVER_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}


@dataclass(frozen=True)
class ProjectCoverDTO:
    path: Path
    width: int
    height: int


class ProjectCoverService:
    @staticmethod
    def cover_path(project_id: str) -> Path:
        return project_dir(project_id) / "cover.jpg"

    def has_cover(self, project_id: str) -> bool:
        return self.cover_path(project_id).is_file()

    def get_cover(self, project_id: str) -> ProjectCoverDTO | None:
        path = self.cover_path(project_id)
        if not path.is_file():
            return None
        width, height = PROJECT_COVER_SIZE
        return ProjectCoverDTO(path=path, width=width, height=height)

    def save_cover(self, project_id: str, filename: str, content: bytes) -> ProjectCoverDTO:
        extension = Path(filename).suffix.lower()
        if extension not in PROJECT_COVER_EXTENSIONS:
            raise ValueError("封面仅支持 JPG、PNG 或 WebP 格式")
        if not content:
            raise ValueError("封面文件不能为空")
        if len(content) > PROJECT_COVER_MAX_BYTES:
            raise ValueError("封面文件不能超过 5 MB")

        encoded = np.frombuffer(content, dtype=np.uint8)
        image = cv2.imdecode(encoded, cv2.IMREAD_COLOR)
        if image is None or image.size == 0:
            raise ValueError("文件内容不是可读取的图片")

        height, width = image.shape[:2]
        target_width, target_height = PROJECT_COVER_SIZE
        target_ratio = target_width / target_height
        source_ratio = width / height
        if source_ratio > target_ratio:
            crop_width = max(1, round(height * target_ratio))
            offset = (width - crop_width) // 2
            image = image[:, offset : offset + crop_width]
        elif source_ratio < target_ratio:
            crop_height = max(1, round(width / target_ratio))
            offset = (height - crop_height) // 2
            image = image[offset : offset + crop_height, :]

        interpolation = cv2.INTER_AREA if image.shape[1] > target_width else cv2.INTER_CUBIC
        normalized = cv2.resize(image, PROJECT_COVER_SIZE, interpolation=interpolation)
        destination = self.cover_path(project_id)
        temporary = destination.with_name(f"cover-{uuid.uuid4().hex}.tmp.jpg")
        try:
            write_image_bgr(temporary, normalized, quality=88)
            temporary.replace(destination)
        finally:
            temporary.unlink(missing_ok=True)
        return ProjectCoverDTO(path=destination, width=target_width, height=target_height)


project_cover_service = ProjectCoverService()
