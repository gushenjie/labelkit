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
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None

    model_config = {"from_attributes": True}


class FrameFeedback(BaseModel):
    status: FrameStatus
    note: str = ""


class AnnotationsUpdate(BaseModel):
    annotations: list[dict[str, Any]]
    status: FrameStatus = FrameStatus.HUMAN_OK


class TrainParams(BaseModel):
    epochs: int = 80
    imgsz: int = 640
    batch: int = 8
    device: str = "mps"
    base_model: str = "yolov8s.pt"
    run_name: str = "labelkit_train"


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
    created_at: datetime

    model_config = {"from_attributes": True}


class LabelEstimate(BaseModel):
    frame_count: int
    cost_per_image: float
    estimated_cost: float
