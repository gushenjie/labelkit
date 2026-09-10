"""训练模型 RTSP 实时预览接口。"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from server.api.deps import get_current_user
from server.api.model_preview_schemas import (
    ModelPreviewCreatedOut,
    ModelPreviewCreateIn,
    ModelPreviewStatusOut,
)
from server.config import settings
from server.core.model_preview import (
    PreviewCapacityError,
    PreviewRuntimeConfig,
    PreviewSession,
    PreviewSessionManager,
    PreviewSessionNotFoundError,
    PreviewSessionSnapshot,
)
from server.db.database import get_db
from server.db.models import ModelVersion, Project, ProjectTaskType
from server.services.user_service import UserDTO

router = APIRouter(
    prefix="/api/projects/{project_id}/models/{model_id}/preview-sessions",
    tags=["model-previews"],
)

preview_manager = PreviewSessionManager(
    max_sessions=settings.preview_max_sessions,
    runtime=PreviewRuntimeConfig(
        connect_timeout_seconds=settings.preview_connect_timeout_seconds,
        idle_timeout_seconds=settings.preview_idle_timeout_seconds,
        jpeg_quality=settings.preview_jpeg_quality,
        max_frame_width=settings.preview_max_frame_width,
        reconnect_attempts=settings.preview_reconnect_attempts,
    ),
)


@router.post("", response_model=ModelPreviewCreatedOut, status_code=status.HTTP_201_CREATED)
def create_preview_session(
    project_id: str,
    model_id: str,
    body: ModelPreviewCreateIn,
    db: Session = Depends(get_db),
    current_user: UserDTO = Depends(get_current_user),
) -> ModelPreviewCreatedOut:
    """创建一个内存 RTSP 模型预览会话。"""

    model = _get_preview_model(db, project_id=project_id, model_id=model_id)
    try:
        session = preview_manager.create(
            user_id=current_user.id,
            project_id=project_id,
            model_id=model_id,
            model_name=model.name,
            model_path=Path(model.filepath),
            rtsp_url=body.rtsp_url,
            confidence_threshold=body.confidence_threshold,
            target_inference_fps=body.inference_fps,
        )
    except ValueError as exc:
        raise _api_error(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "INVALID_RTSP_URL",
            str(exc),
        ) from exc
    except PreviewCapacityError as exc:
        raise _api_error(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "PREVIEW_CAPACITY_EXCEEDED",
            str(exc),
        ) from exc

    return ModelPreviewCreatedOut(
        session_id=session.session_id,
        status=session.status.value,
        stream_path=_stream_path(session),
        created_at=session.created_at,
    )


@router.get("/{session_id}", response_model=ModelPreviewStatusOut)
def get_preview_session(
    project_id: str,
    model_id: str,
    session_id: str,
    current_user: UserDTO = Depends(get_current_user),
) -> ModelPreviewStatusOut:
    """查询当前用户的模型预览状态。"""

    return _snapshot_out(_get_session(session_id, current_user, project_id, model_id).snapshot())


@router.get("/{session_id}/stream", response_class=StreamingResponse)
def stream_preview_session(
    project_id: str,
    model_id: str,
    session_id: str,
    current_user: UserDTO = Depends(get_current_user),
) -> StreamingResponse:
    """以 MJPEG 输出当前会话最新检测画面。"""

    session = _get_session(session_id, current_user, project_id, model_id)
    return StreamingResponse(
        session.iter_mjpeg(),
        media_type="multipart/x-mixed-replace; boundary=frame",
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
        },
    )


@router.delete("/{session_id}", response_model=ModelPreviewStatusOut)
def stop_preview_session(
    project_id: str,
    model_id: str,
    session_id: str,
    current_user: UserDTO = Depends(get_current_user),
) -> ModelPreviewStatusOut:
    """幂等停止当前用户的模型预览会话。"""

    try:
        session = preview_manager.stop(
            session_id=session_id,
            user_id=current_user.id,
            project_id=project_id,
            model_id=model_id,
        )
    except PreviewSessionNotFoundError as exc:
        raise _api_error(status.HTTP_404_NOT_FOUND, "PREVIEW_NOT_FOUND", "预览会话不存在") from exc
    return _snapshot_out(session.snapshot())


def _get_preview_model(db: Session, *, project_id: str, model_id: str) -> ModelVersion:
    project = db.get(Project, project_id)
    model = db.get(ModelVersion, model_id)
    if project is None or model is None or model.project_id != project_id:
        raise _api_error(status.HTTP_404_NOT_FOUND, "MODEL_NOT_FOUND", "模型不存在或不属于当前项目")
    if project.task_type != ProjectTaskType.DETECT:
        raise _api_error(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "UNSUPPORTED_MODEL_TASK",
            "实时预览仅支持目标检测模型",
        )
    if not Path(model.filepath).is_file():
        raise _api_error(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "MODEL_FILE_MISSING",
            "模型文件不存在，请重新训练或上传模型",
        )
    return model


def _get_session(
    session_id: str,
    current_user: UserDTO,
    project_id: str,
    model_id: str,
) -> PreviewSession:
    try:
        return preview_manager.get(
            session_id=session_id,
            user_id=current_user.id,
            project_id=project_id,
            model_id=model_id,
        )
    except PreviewSessionNotFoundError as exc:
        raise _api_error(status.HTTP_404_NOT_FOUND, "PREVIEW_NOT_FOUND", "预览会话不存在") from exc


def _snapshot_out(snapshot: PreviewSessionSnapshot) -> ModelPreviewStatusOut:
    return ModelPreviewStatusOut(
        session_id=snapshot.session_id,
        status=snapshot.status.value,
        model_name=snapshot.model_name,
        frame_width=snapshot.frame_width,
        frame_height=snapshot.frame_height,
        inference_fps=snapshot.inference_fps,
        last_inference_ms=snapshot.last_inference_ms,
        detection_count=snapshot.detection_count,
        class_counts=snapshot.class_counts,
        last_frame_at=snapshot.last_frame_at,
        error_code=snapshot.error_code,
        error_message=snapshot.error_message,
    )


def _stream_path(session: PreviewSession) -> str:
    return (
        f"/api/projects/{session.project_id}/models/{session.model_id}"
        f"/preview-sessions/{session.session_id}/stream"
    )


def _api_error(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message})
