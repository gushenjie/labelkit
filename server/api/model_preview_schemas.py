"""RTSP 模型预览 API Schema。"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from server.config import settings


class ModelPreviewCreateIn(BaseModel):
    """创建模型实时预览的输入。"""

    model_config = ConfigDict(populate_by_name=True)

    rtsp_url: str = Field(alias="rtspUrl", min_length=8, max_length=2048)
    confidence_threshold: float = Field(0.25, alias="confidenceThreshold", ge=0.01, le=1.0)
    # 0 = 不限速，按最新帧尽快推理；>0 时为节流目标 FPS
    inference_fps: float = Field(
        settings.preview_default_inference_fps,
        alias="inferenceFps",
        ge=0.0,
        le=settings.preview_max_inference_fps,
    )


class ModelPreviewCreatedOut(BaseModel):
    """模型实时预览创建结果。"""

    model_config = ConfigDict(populate_by_name=True)

    session_id: str = Field(alias="sessionId")
    status: str
    stream_path: str = Field(alias="streamPath")
    created_at: datetime = Field(alias="createdAt")


class ModelPreviewStatusOut(BaseModel):
    """模型实时预览状态。"""

    model_config = ConfigDict(populate_by_name=True)

    session_id: str = Field(alias="sessionId")
    status: str
    model_name: str = Field(alias="modelName")
    frame_width: int | None = Field(alias="frameWidth")
    frame_height: int | None = Field(alias="frameHeight")
    inference_fps: float = Field(alias="inferenceFps")
    last_inference_ms: int | None = Field(alias="lastInferenceMs")
    detection_count: int = Field(alias="detectionCount")
    class_counts: dict[str, int] = Field(alias="classCounts")
    last_frame_at: datetime | None = Field(alias="lastFrameAt")
    error_code: str | None = Field(alias="errorCode")
    error_message: str | None = Field(alias="errorMessage")
