"""Business DTOs for public dataset discovery and import."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path


@dataclass(frozen=True)
class PublicDatasetCandidateDTO:
    provider: str
    source_ref: str
    source_version: str
    source_url: str
    title: str
    description: str
    license_name: str
    license_url: str
    download_bytes: int | None
    image_count: int | None
    task_type: str | None
    classes: tuple[str, ...] = ()
    updated_at: str = ""
    score: float = 0.0
    requires_manual_license_confirmation: bool = True
    recommendation_reason: str = ""
    stars: int | None = None
    downloads: int | None = None
    views: int | None = None


@dataclass(frozen=True)
class PublicImportDTO:
    id: str
    project_id: str
    provider: str
    source_ref: str
    source_version: str
    source_url: str
    title: str
    license_name: str
    license_url: str
    license_fingerprint: str
    state: str
    expected_download_bytes: int | None
    actual_download_bytes: int
    extracted_bytes: int
    artifact_checksum: str
    detected_format: str
    detected_root: str
    source_classes: tuple[dict, ...]
    class_mapping: dict[str, int | None]
    quality_report: dict
    review_frame_ids: tuple[str, ...]
    workflow_metadata: dict
    staging_path: Path
    fetch_task_id: str | None
    import_task_id: str | None
    dataset_version_id: str | None
    train_task_id: str | None


@dataclass(frozen=True)
class SourceLabelDTO:
    class_id: int
    x_center: float | None = None
    y_center: float | None = None
    width: float | None = None
    height: float | None = None

    def to_list(self) -> list[int | float | None]:
        return [self.class_id, self.x_center, self.y_center, self.width, self.height]


@dataclass(frozen=True)
class ManifestEntryDTO:
    image: str
    filename: str
    split: str
    source_group_id: str
    image_checksum: str
    phash: str
    labels: tuple[SourceLabelDTO, ...] = ()
    warnings: tuple[str, ...] = ()

    def to_dict(self) -> dict:
        return {
            "image": self.image,
            "filename": self.filename,
            "split": self.split,
            "source_group_id": self.source_group_id,
            "image_checksum": self.image_checksum,
            "phash": self.phash,
            "labels": [label.to_list() for label in self.labels],
            "warnings": list(self.warnings),
        }


@dataclass(frozen=True)
class DatasetInspectionDTO:
    format: str
    root: Path
    task_type: str
    classes: tuple[dict, ...]
    entries: tuple[ManifestEntryDTO, ...]
    quality_report: dict = field(default_factory=dict)

    def manifest(self) -> dict:
        return {
            "schema_version": 1,
            "format": self.format,
            "task_type": self.task_type,
            "classes": list(self.classes),
            "entries": [entry.to_dict() for entry in self.entries],
        }


@dataclass(frozen=True)
class ProjectImportContextDTO:
    project_id: str
    task_type: str
    categories: tuple[dict, ...]


@dataclass(frozen=True)
class PublishFrameDTO:
    source_path: Path
    filename: str
    split: str
    source_group_id: str
    image_checksum: str
    phash: str
    labels: tuple[SourceLabelDTO, ...]
    status: str
    original_labels: tuple[tuple[int, float | None, float | None, float | None, float | None], ...]


@dataclass(frozen=True)
class ReviewFrameDTO:
    id: str
    status: str
    split: str
    labels: tuple[tuple[int, float | None, float | None, float | None, float | None], ...]
    class_ids: tuple[int, ...]
