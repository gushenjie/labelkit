"""SQLAlchemy models."""

from __future__ import annotations

import enum
import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    Boolean,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    JSON,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _uuid() -> str:
    return str(uuid.uuid4())


class Base(DeclarativeBase):
    pass


class TaskType(str, enum.Enum):
    EXTRACT = "extract"
    DEDUP = "dedup"
    LABEL = "label"
    REVIEW = "review"
    TRAIN = "train"
    EXPORT = "export"
    RELABEL = "relabel"
    IMPORT = "import"
    DERIVE_CLASSIFY = "derive_classify"
    PUBLIC_FETCH = "public_fetch"
    PUBLIC_IMPORT = "public_import"


class TaskStatus(str, enum.Enum):
    PENDING = "pending"
    RUNNING = "running"
    PAUSED = "paused"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    INTERRUPTED = "interrupted"


class FrameStatus(str, enum.Enum):
    UNLABELED = "unlabeled"
    LLM_LABELED = "llm_labeled"
    AUTO_OK = "auto_ok"
    AUTO_FIXED = "auto_fixed"
    NEEDS_HUMAN = "needs_human"
    HUMAN_OK = "human_ok"
    HUMAN_WRONG = "human_wrong"
    NO_TARGET = "no_target"


class ProjectTaskType(str, enum.Enum):
    DETECT = "detect"
    CLASSIFY = "classify"


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="")
    task_type: Mapped[ProjectTaskType] = mapped_column(
        Enum(ProjectTaskType), default=ProjectTaskType.DETECT
    )
    label_prompt: Mapped[str] = mapped_column(Text, default="")
    review_prompt: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow
    )

    categories: Mapped[list[Category]] = relationship(back_populates="project", cascade="all, delete-orphan")
    videos: Mapped[list[Video]] = relationship(back_populates="project", cascade="all, delete-orphan")
    frames: Mapped[list[Frame]] = relationship(back_populates="project", cascade="all, delete-orphan")
    tasks: Mapped[list[Task]] = relationship(back_populates="project", cascade="all, delete-orphan")
    models: Mapped[list[ModelVersion]] = relationship(back_populates="project", cascade="all, delete-orphan")
    dataset_versions: Mapped[list[DatasetVersion]] = relationship(back_populates="project", cascade="all, delete-orphan")
    public_dataset_imports: Mapped[list[PublicDatasetImport]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )


class Category(Base):
    __tablename__ = "categories"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    class_id: Mapped[int] = mapped_column(Integer, nullable=False)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="")
    color: Mapped[str] = mapped_column(String(20), default="#FF8C00")
    required: Mapped[bool] = mapped_column(Boolean, default=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)

    project: Mapped[Project] = relationship(back_populates="categories")


class Video(Base):
    __tablename__ = "videos"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    filename: Mapped[str] = mapped_column(String(500), nullable=False)
    storage_key: Mapped[str | None] = mapped_column(String(100), nullable=True, unique=True)
    filepath: Mapped[str] = mapped_column(String(1000), nullable=False)
    duration_sec: Mapped[float | None] = mapped_column(Float, nullable=True)
    fps: Mapped[float | None] = mapped_column(Float, nullable=True)
    frame_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    split: Mapped[str] = mapped_column(String(20), default="train")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    project: Mapped[Project] = relationship(back_populates="videos")
    frames: Mapped[list[Frame]] = relationship(back_populates="video")


class Frame(Base):
    __tablename__ = "frames"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    video_id: Mapped[str | None] = mapped_column(ForeignKey("videos.id", ondelete="SET NULL"), nullable=True, index=True)
    filename: Mapped[str] = mapped_column(String(500), nullable=False)
    storage_key: Mapped[str | None] = mapped_column(String(100), nullable=True, unique=True)
    source_group_id: Mapped[str | None] = mapped_column(String(100), nullable=True, index=True)
    public_import_id: Mapped[str | None] = mapped_column(
        ForeignKey("public_dataset_imports.id", ondelete="SET NULL"), nullable=True, index=True
    )
    filepath: Mapped[str] = mapped_column(String(1000), nullable=False)
    split: Mapped[str] = mapped_column(String(20), default="train")
    phash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    status: Mapped[FrameStatus] = mapped_column(Enum(FrameStatus), default=FrameStatus.UNLABELED)
    note: Mapped[str] = mapped_column(Text, default="")
    review_note: Mapped[str] = mapped_column(Text, default="")
    source: Mapped[str] = mapped_column(String(50), default="")
    uncertainty: Mapped[float] = mapped_column(Float, default=0.0)
    frame_index: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow
    )

    project: Mapped[Project] = relationship(back_populates="frames")
    video: Mapped[Video | None] = relationship(back_populates="frames")
    annotations: Mapped[list[Annotation]] = relationship(back_populates="frame", cascade="all, delete-orphan")
    public_import: Mapped[PublicDatasetImport | None] = relationship(back_populates="frames")


class Annotation(Base):
    __tablename__ = "annotations"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    frame_id: Mapped[str] = mapped_column(ForeignKey("frames.id", ondelete="CASCADE"), index=True)
    class_id: Mapped[int] = mapped_column(Integer, nullable=False)
    # detect: normalized yolo xywh; classify: class_id only with bbox null
    x_center: Mapped[float | None] = mapped_column(Float, nullable=True)
    y_center: Mapped[float | None] = mapped_column(Float, nullable=True)
    width: Mapped[float | None] = mapped_column(Float, nullable=True)
    height: Mapped[float | None] = mapped_column(Float, nullable=True)
    confidence: Mapped[float] = mapped_column(Float, default=1.0)
    source: Mapped[str] = mapped_column(String(50), default="manual")

    frame: Mapped[Frame] = relationship(back_populates="annotations")


class Task(Base):
    __tablename__ = "tasks"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    task_type: Mapped[TaskType] = mapped_column(Enum(TaskType), nullable=False)
    status: Mapped[TaskStatus] = mapped_column(Enum(TaskStatus), default=TaskStatus.PENDING)
    progress: Mapped[int] = mapped_column(Integer, default=0)
    total: Mapped[int] = mapped_column(Integer, default=0)
    params: Mapped[dict] = mapped_column(JSON, default=dict)
    result: Mapped[dict] = mapped_column(JSON, default=dict)
    log: Mapped[str] = mapped_column(Text, default="")
    error: Mapped[str] = mapped_column(Text, default="")
    cancel_requested: Mapped[bool] = mapped_column(Boolean, default=False)
    heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    retry_of_task_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    project: Mapped[Project] = relationship(back_populates="tasks")


class ModelVersion(Base):
    __tablename__ = "model_versions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    filepath: Mapped[str] = mapped_column(String(1000), nullable=False)
    metrics: Mapped[dict] = mapped_column(JSON, default=dict)
    dataset_snapshot: Mapped[dict] = mapped_column(JSON, default=dict)
    task_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    dataset_version_id: Mapped[str | None] = mapped_column(ForeignKey("dataset_versions.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    project: Mapped[Project] = relationship(back_populates="models")


class DatasetVersion(Base):
    __tablename__ = "dataset_versions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(String(30), default="ready")
    checksum: Mapped[str] = mapped_column(String(64), nullable=False)
    categories: Mapped[list] = mapped_column(JSON, default=list)
    manifest: Mapped[dict] = mapped_column(JSON, default=dict)
    snapshot_path: Mapped[str] = mapped_column(String(1000), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)

    project: Mapped[Project] = relationship(back_populates="dataset_versions")


class PublicDatasetImport(Base):
    __tablename__ = "public_dataset_imports"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    provider: Mapped[str] = mapped_column(String(30), nullable=False)
    source_ref: Mapped[str] = mapped_column(String(500), nullable=False)
    source_version: Mapped[str] = mapped_column(String(100), default="")
    source_url: Mapped[str] = mapped_column(String(1000), default="")
    title: Mapped[str] = mapped_column(String(500), default="")
    license_name: Mapped[str] = mapped_column(String(200), default="unknown")
    license_url: Mapped[str] = mapped_column(String(1000), default="")
    license_fingerprint: Mapped[str] = mapped_column(String(64), nullable=False)
    license_confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    state: Mapped[str] = mapped_column(String(40), default="created", index=True)
    expected_download_bytes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    actual_download_bytes: Mapped[int] = mapped_column(Integer, default=0)
    extracted_bytes: Mapped[int] = mapped_column(Integer, default=0)
    artifact_checksum: Mapped[str] = mapped_column(String(64), default="")
    detected_format: Mapped[str] = mapped_column(String(40), default="")
    detected_root: Mapped[str] = mapped_column(String(1000), default="")
    source_classes: Mapped[list] = mapped_column(JSON, default=list)
    class_mapping: Mapped[dict] = mapped_column(JSON, default=dict)
    quality_report: Mapped[dict] = mapped_column(JSON, default=dict)
    review_frame_ids: Mapped[list] = mapped_column(JSON, default=list)
    workflow_metadata: Mapped[dict] = mapped_column(JSON, default=dict)
    staging_path: Mapped[str] = mapped_column(String(1000), default="")
    fetch_task_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    import_task_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    dataset_version_id: Mapped[str | None] = mapped_column(
        ForeignKey("dataset_versions.id"), nullable=True
    )
    train_task_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_utcnow, onupdate=_utcnow
    )

    project: Mapped[Project] = relationship(back_populates="public_dataset_imports")
    frames: Mapped[list[Frame]] = relationship(back_populates="public_import")


class ProjectExecutionLease(Base):
    __tablename__ = "project_execution_leases"

    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True)
    task_id: Mapped[str] = mapped_column(String(36), nullable=False, unique=True)
    acquired_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
