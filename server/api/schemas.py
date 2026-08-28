"""Pydantic schemas."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field

from server.db.models import FrameStatus, ProjectTaskType, TaskStatus, TaskType


class CategoryCreate(BaseModel):
    class_id: int
    name: str
    description: str = ""
    color: str = "#FF8C00"
    required: bool = True
    sort_order: int = 0


class CategoryOut(CategoryCreate):
    id: str

    model_config = {"from_attributes": True}


class ProjectCreate(BaseModel):
    name: str
    description: str = ""
    task_type: ProjectTaskType = ProjectTaskType.DETECT
    label_prompt: str = ""
    review_prompt: str = ""
    categories: list[CategoryCreate] = Field(default_factory=list)


class ProjectUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    label_prompt: str | None = None
    review_prompt: str | None = None


class ProjectOut(BaseModel):
    id: str
    name: str
    description: str
    task_type: ProjectTaskType
    label_prompt: str
    review_prompt: str
    created_at: datetime
    updated_at: datetime
    categories: list[CategoryOut] = Field(default_factory=list)
    frame_count: int = 0
    video_count: int = 0
    disk_usage_mb: float = 0.0

    model_config = {"from_attributes": True}


class ProjectOverviewOut(BaseModel):
    project: ProjectOut
    stats: dict[str, int] = Field(default_factory=dict)
    preview_frame_id: str | None = None


class VideoOut(BaseModel):
    id: str
    filename: str
    duration_sec: float | None
    fps: float | None
    frame_count: int | None
    split: str
    extracted_count: int = 0
    created_at: datetime

    model_config = {"from_attributes": True}


class AnnotationOut(BaseModel):
    id: str
    class_id: int
    x_center: float | None
    y_center: float | None
    width: float | None
    height: float | None
    confidence: float
    source: str

    model_config = {"from_attributes": True}


class FrameOut(BaseModel):
    id: str
    filename: str
    split: str
    status: FrameStatus
    note: str
    review_note: str
    source: str
    uncertainty: float
    video_id: str | None
    has_labels: bool = False
    annotations: list[AnnotationOut] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class TaskCreate(BaseModel):
    task_type: TaskType
    params: dict[str, Any] = Field(default_factory=dict)


class TaskOut(BaseModel):
    id: str
    project_id: str
    task_type: TaskType
    status: TaskStatus
    progress: int
    total: int
    params: dict[str, Any]
    result: dict[str, Any]
    log: str
    error: str
    cancel_requested: bool
    heartbeat_at: datetime | None
    retry_of_task_id: str | None
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None

    model_config = {"from_attributes": True}


class GlobalTaskOut(TaskOut):
    project_name: str


class FrameFeedback(BaseModel):
    status: FrameStatus
    note: str = ""


class AnnotationsUpdate(BaseModel):
    annotations: list[dict[str, Any]]
    status: FrameStatus = FrameStatus.HUMAN_OK


class TrainParams(BaseModel):
    epochs: int = Field(default=80, ge=1, le=1000)
    imgsz: int = Field(default=640, ge=32, le=4096)
    batch: int = Field(default=8, ge=1, le=1024)
    device: str = "auto"
    base_model: str = ""


class SettingsOut(BaseModel):
    dashscope_api_key_set: bool
    vlm_model: str
    vlm_base_url: str
    vlm_max_concurrency: int
    vlm_cost_per_image: float


class SettingsUpdate(BaseModel):
    dashscope_api_key: str | None = None
    vlm_model: str | None = None
    vlm_base_url: str | None = None
    vlm_max_concurrency: int | None = None
    vlm_cost_per_image: float | None = None


class ModelVersionOut(BaseModel):
    id: str
    version: int
    name: str
    filepath: str
    metrics: dict[str, Any]
    dataset_snapshot: dict[str, Any]
    dataset_version_id: str | None
    created_at: datetime

    model_config = {"from_attributes": True}


class LabelEstimate(BaseModel):
    frame_count: int
    cost_per_image: float
    estimated_cost: float


class DatasetVersionCreate(BaseModel):
    val_ratio: float = Field(default=0.2, ge=0.05, le=0.5)


class DatasetVersionOut(BaseModel):
    id: str
    project_id: str
    version: int
    status: str
    checksum: str
    categories: list[dict[str, Any]]
    manifest: dict[str, Any]
    created_at: datetime

    model_config = {"from_attributes": True}


class FramePage(BaseModel):
    items: list[FrameOut]
    next_cursor: str | None
    total: int


class PublicDatasetDiscoverRequest(BaseModel):
    query: str = Field(default="", max_length=500)
    roboflow_url: str = Field(default="", max_length=1000)


class PublicDatasetCandidateOut(BaseModel):
    provider: str
    source_ref: str
    source_version: str
    source_url: str
    title: str
    description: str
    license_name: str
    license_url: str
    license_fingerprint: str
    download_bytes: int | None
    image_count: int | None
    task_type: str | None
    classes: list[str] = Field(default_factory=list)
    updated_at: str = ""
    score: float = 0.0
    requires_manual_license_confirmation: bool = True
    recommendation_reason: str = ""
    stars: int | None = None
    downloads: int | None = None
    views: int | None = None


class PublicDatasetDiscoverOut(BaseModel):
    candidates: list[PublicDatasetCandidateOut]
    errors: dict[str, str] = Field(default_factory=dict)


class PublicDatasetFetchRequest(BaseModel):
    provider: str
    source_ref: str
    source_url: str = ""
    license_fingerprint: str = Field(min_length=64, max_length=64)
    license_confirmed: bool


class PublicDatasetPublishRequest(BaseModel):
    class_mapping: dict[str, int | None]
    warnings_confirmed: bool = False
    auto_label: bool = False
    cost_confirmed: bool = False
    training_params: TrainParams = Field(default_factory=TrainParams)


class PublicDatasetImportOut(BaseModel):
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
    source_classes: list[dict[str, Any]]
    class_mapping: dict[str, int | None]
    suggested_mapping: dict[str, int | None] = Field(default_factory=dict)
    quality_report: dict[str, Any]
    review_frame_ids: list[str]
    fetch_task_id: str | None
    import_task_id: str | None
    dataset_version_id: str | None
    train_task_id: str | None
    estimated_vlm_cost: float = 0.0
