"""Persistence boundary for public dataset workflows."""

from __future__ import annotations

import os
import shutil
import uuid
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy.orm import Session

from server.core.paths import frames_dir, label_path_for_frame, labels_dir
from server.core.public_dataset_adapters import license_fingerprint
from server.core.public_dataset_types import (
    ProjectImportContextDTO,
    PublicDatasetCandidateDTO,
    PublicImportDTO,
    PublishFrameDTO,
    ReviewFrameDTO,
)
from server.core.yolo_io import write_labels
from server.db.models import (
    Annotation,
    Category,
    DatasetVersion,
    Frame,
    FrameStatus,
    ModelVersion,
    Project,
    PublicDatasetImport,
)


def _dto(model: PublicDatasetImport) -> PublicImportDTO:
    return PublicImportDTO(
        id=model.id,
        project_id=model.project_id,
        provider=model.provider,
        source_ref=model.source_ref,
        source_version=model.source_version,
        source_url=model.source_url,
        title=model.title,
        license_name=model.license_name,
        license_url=model.license_url,
        license_fingerprint=model.license_fingerprint,
        state=model.state,
        expected_download_bytes=model.expected_download_bytes,
        actual_download_bytes=model.actual_download_bytes,
        extracted_bytes=model.extracted_bytes,
        artifact_checksum=model.artifact_checksum,
        detected_format=model.detected_format,
        detected_root=model.detected_root,
        source_classes=tuple(model.source_classes or []),
        class_mapping=dict(model.class_mapping or {}),
        quality_report=dict(model.quality_report or {}),
        review_frame_ids=tuple(model.review_frame_ids or []),
        workflow_metadata=dict(model.workflow_metadata or {}),
        staging_path=Path(model.staging_path),
        fetch_task_id=model.fetch_task_id,
        import_task_id=model.import_task_id,
        dataset_version_id=model.dataset_version_id,
        train_task_id=model.train_task_id,
    )


class PublicDatasetRepository:
    def __init__(self, db: Session):
        self._db = db

    def project_context(self, project_id: str) -> ProjectImportContextDTO | None:
        project = self._db.get(Project, project_id)
        if not project:
            return None
        categories = (
            self._db.query(Category)
            .filter(Category.project_id == project_id)
            .order_by(Category.class_id)
            .all()
        )
        return ProjectImportContextDTO(
            project_id=project_id,
            task_type=project.task_type.value,
            categories=tuple(
                {"class_id": category.class_id, "name": category.name}
                for category in categories
            ),
        )

    def create_import(
        self,
        project_id: str,
        candidate: PublicDatasetCandidateDTO,
        *,
        imports_root: Path,
        license_confirmed: bool,
        task_type: str,
    ) -> PublicImportDTO:
        fingerprint = license_fingerprint(
            candidate.provider,
            candidate.source_ref,
            candidate.source_version,
            candidate.license_name,
            candidate.license_url,
        )
        import_id = str(uuid.uuid4())
        model = PublicDatasetImport(
            id=import_id,
            project_id=project_id,
            provider=candidate.provider,
            source_ref=candidate.source_ref,
            source_version=candidate.source_version,
            source_url=candidate.source_url,
            title=candidate.title,
            license_name=candidate.license_name,
            license_url=candidate.license_url,
            license_fingerprint=fingerprint,
            license_confirmed_at=datetime.now(timezone.utc) if license_confirmed else None,
            expected_download_bytes=candidate.download_bytes,
            staging_path=str(imports_root / import_id / "staging"),
            workflow_metadata={"task_type": task_type},
        )
        self._db.add(model)
        self._db.flush()
        return _dto(model)

    def get(self, project_id: str, import_id: str) -> PublicImportDTO | None:
        model = self._db.get(PublicDatasetImport, import_id)
        if not model or model.project_id != project_id:
            return None
        return _dto(model)

    def get_by_id(self, import_id: str) -> PublicImportDTO | None:
        model = self._db.get(PublicDatasetImport, import_id)
        return _dto(model) if model else None

    def list_for_project(self, project_id: str) -> tuple[PublicImportDTO, ...]:
        models = (
            self._db.query(PublicDatasetImport)
            .filter(PublicDatasetImport.project_id == project_id)
            .order_by(PublicDatasetImport.created_at.desc(), PublicDatasetImport.id.desc())
            .all()
        )
        return tuple(_dto(model) for model in models)

    def update(self, import_id: str, **values) -> PublicImportDTO:
        model = self._db.get(PublicDatasetImport, import_id)
        if not model:
            raise RuntimeError(f"Public dataset import not found: {import_id}")
        for name, value in values.items():
            if not hasattr(model, name):
                raise RuntimeError(f"Unsupported public import field: {name}")
            setattr(model, name, value)
        self._db.flush()
        return _dto(model)

    def publish_frames(
        self,
        import_record: PublicImportDTO,
        frames: tuple[PublishFrameDTO, ...],
        *,
        cancelled: Callable[[], bool] | None = None,
    ) -> tuple[str, ...]:
        if import_record.state in {"review", "needs_label", "published", "training", "completed"}:
            existing = (
                self._db.query(Frame.id)
                .filter(Frame.public_import_id == import_record.id)
                .order_by(Frame.id)
                .all()
            )
            return tuple(frame_id for (frame_id,) in existing)

        try:
            uuid.UUID(import_record.id)
        except ValueError as error:
            raise RuntimeError("公开数据 Import ID 无效") from error
        storage_prefix = f"public-{import_record.id}-"
        # A process may have stopped after creating files but before SQLite commit.
        # These names are reserved for this import and cannot belong to other media.
        for split in ("train", "val", "test"):
            for orphan in frames_dir(import_record.project_id, split).glob(f"{storage_prefix}*"):
                if orphan.is_file():
                    orphan.unlink()
            for orphan in labels_dir(import_record.project_id, split).glob(f"{storage_prefix}*.txt"):
                if orphan.is_file():
                    orphan.unlink()

        moved: list[tuple[Path, Path]] = []
        created_ids: list[str] = []
        try:
            for item in frames:
                if cancelled and cancelled():
                    raise RuntimeError("任务已取消")
                storage_key = f"{storage_prefix}{uuid.uuid4().hex}"
                suffix = item.source_path.suffix.lower() or ".jpg"
                destination = frames_dir(import_record.project_id, item.split) / f"{storage_key}{suffix}"
                destination.parent.mkdir(parents=True, exist_ok=True)
                try:
                    os.link(item.source_path, destination)
                except OSError:
                    shutil.copy2(item.source_path, destination)
                moved.append((destination, item.source_path))
                frame = Frame(
                    project_id=import_record.project_id,
                    public_import_id=import_record.id,
                    filename=item.filename,
                    storage_key=storage_key,
                    source_group_id=item.source_group_id,
                    filepath=str(destination),
                    split=item.split,
                    phash=item.phash,
                    status=FrameStatus(item.status),
                    source="public",
                    note=f"公开数据: {import_record.provider}/{import_record.source_ref}",
                )
                self._db.add(frame)
                self._db.flush()
                created_ids.append(frame.id)
                yolo_labels = []
                for label in item.labels:
                    self._db.add(
                        Annotation(
                            frame_id=frame.id,
                            class_id=label.class_id,
                            x_center=label.x_center,
                            y_center=label.y_center,
                            width=label.width,
                            height=label.height,
                            source="public",
                        )
                    )
                    if label.x_center is not None:
                        yolo_labels.append(
                            (label.class_id, label.x_center, label.y_center, label.width, label.height)
                        )
                if import_record.workflow_metadata.get("task_type") == "detect":
                    write_labels(label_path_for_frame(import_record.project_id, frame), yolo_labels)
            self._db.flush()
            return tuple(created_ids)
        except Exception:
            self._db.rollback()
            for destination, _source in reversed(moved):
                if destination.exists():
                    destination.unlink(missing_ok=True)
            raise

    def frames_for_import(self, import_id: str) -> list[Frame]:
        return (
            self._db.query(Frame)
            .filter(Frame.public_import_id == import_id)
            .order_by(Frame.id)
            .all()
        )

    def review_frames(self, import_id: str, frame_ids: set[str] | None = None) -> tuple[ReviewFrameDTO, ...]:
        query = self._db.query(Frame).filter(Frame.public_import_id == import_id)
        if frame_ids is not None:
            query = query.filter(Frame.id.in_(frame_ids))
        rows = query.order_by(Frame.id).all()
        return tuple(
            ReviewFrameDTO(
                id=frame.id,
                status=frame.status.value,
                split=frame.split,
                labels=tuple(
                    (
                        annotation.class_id,
                        annotation.x_center,
                        annotation.y_center,
                        annotation.width,
                        annotation.height,
                    )
                    for annotation in sorted(frame.annotations, key=lambda item: item.id)
                ),
                class_ids=tuple(sorted({annotation.class_id for annotation in frame.annotations})),
            )
            for frame in rows
        )

    def mark_for_review(self, frame_ids: list[str]) -> None:
        if not frame_ids:
            return
        self._db.query(Frame).filter(Frame.id.in_(frame_ids)).update(
            {Frame.status: FrameStatus.NEEDS_HUMAN}, synchronize_session=False
        )
        self._db.flush()

    def discard(self, import_record: PublicImportDTO) -> int:
        if import_record.dataset_version_id or import_record.train_task_id:
            raise RuntimeError("该公开数据已进入数据版本或训练，不能放弃")
        removed = self.remove_published_frames(import_record)
        model = self._db.get(PublicDatasetImport, import_record.id)
        if model:
            model.state = "discarded"
        self._db.flush()
        return removed

    def remove_published_frames(self, import_record: PublicImportDTO) -> int:
        frames = self.frames_for_import(import_record.id)
        for frame in frames:
            Path(frame.filepath).unlink(missing_ok=True)
            label_path_for_frame(import_record.project_id, frame).unlink(missing_ok=True)
            self._db.delete(frame)
        self._db.flush()
        return len(frames)
