"""Schemas for the global model catalog."""

from __future__ import annotations

from pydantic import BaseModel, Field


class ModelCatalogStatOut(BaseModel):
    label: str
    value: str
    change: str
    icon: str


class ModelCatalogMetricOut(BaseModel):
    label: str
    value: str
    change: str
    direction: str = "up"


class ModelCatalogItemOut(BaseModel):
    id: str
    name: str
    version: str
    category: str
    description: str
    icon: str
    framework: str
    task: str
    status: str
    metrics: list[ModelCatalogMetricOut]
    updated_at: str
    source: str = "内置模型"
    metadata: list[str] = Field(default_factory=list)
    project_name: str | None = None
    project_id: str | None = None
    model_id: str | None = None
    preview_frame_id: str | None = None
    has_cover: bool = False


class ModelCatalogOut(BaseModel):
    stats: list[ModelCatalogStatOut]
    models: list[ModelCatalogItemOut]
    total: int
