"""Immutable dataset version API."""

from __future__ import annotations

import mimetypes
import platform
import shutil
import subprocess

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from server.api.deps import get_optional_actor
from server.api.schemas import (
    DatasetCatalogOut,
    DatasetVersionCreate,
    DatasetVersionDetailOut,
    DatasetVersionOut,
)
from server.core.audit import record_audit
from server.core.dataset_service import DatasetService, DatasetVersionRepository
from server.db.database import get_db
from server.db.models import DatasetVersion, Project

router = APIRouter(prefix="/api/projects/{project_id}/dataset-versions", tags=["datasets"])
global_router = APIRouter(prefix="/api/datasets", tags=["datasets"])


def _reveal_directory(path) -> None:
    system = platform.system()
    if system == "Darwin":
        subprocess.run(["open", str(path)], check=True)
    elif system == "Windows":
        # explorer 即使成功也可能返回非 0，不按返回码判定失败
        subprocess.run(["explorer", str(path)], check=False)
    else:
        subprocess.run(["xdg-open", str(path)], check=True)

@global_router.get("", response_model=DatasetCatalogOut)
def list_dataset_catalog(
    project_id: str = "",
    query: str = "",
    task_type: str = "",
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=200),
    db: Session = Depends(get_db),
):
    service = DatasetService(DatasetVersionRepository(db))
    return DatasetCatalogOut.model_validate(
        service.catalog(
            project_id=project_id,
            query=query,
            task_type=task_type,
            offset=offset,
            limit=limit,
        )
    )


@router.get("", response_model=list[DatasetVersionOut])
def list_dataset_versions(project_id: str, db: Session = Depends(get_db)):
    return (
        db.query(DatasetVersion)
        .filter(DatasetVersion.project_id == project_id)
        .order_by(DatasetVersion.version.desc())
        .all()
    )


@router.post("", response_model=DatasetVersionOut)
def create_dataset_version(
    project_id: str,
    body: DatasetVersionCreate,
    db: Session = Depends(get_db),
    actor: str = Depends(get_optional_actor),
):
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    service = DatasetService(DatasetVersionRepository(db))
    version = None
    try:
        version = service.create_version(project.id, project.task_type, val_ratio=body.val_ratio)
        db.commit()
    except Exception as error:
        db.rollback()
        if version and version.snapshot_path.exists():
            shutil.rmtree(version.snapshot_path)
        if not isinstance(error, RuntimeError):
            raise
        raise HTTPException(400, str(error)) from error
    version = db.get(DatasetVersion, version.id)
    record_audit(
        db,
        actor=actor,
        action="dataset.create",
        resource_type="dataset",
        resource_id=version.id,
        project_id=project_id,
        summary=f"创建数据集版本 v{version.version}",
        metadata={"val_ratio": body.val_ratio},
    )
    return version


@router.get("/{version_id}/cover")
def get_dataset_version_cover(project_id: str, version_id: str, db: Session = Depends(get_db)):
    """返回该版本训练集首张图片，供数据管理列表缩略图使用。"""
    service = DatasetService(DatasetVersionRepository(db))
    try:
        version = service.get_version(project_id, version_id)
        cover = service.resolve_train_cover(version)
    except RuntimeError as error:
        message = str(error)
        status = 404 if "not found" in message.lower() or "不存在" in message or "没有" in message else 400
        raise HTTPException(status, message) from error
    media_type = mimetypes.guess_type(cover.name)[0] or "image/jpeg"
    return FileResponse(
        cover,
        media_type=media_type,
        headers={"Cache-Control": "private, max-age=86400"},
    )


@router.post("/{version_id}/open")
def open_dataset_version_folder(project_id: str, version_id: str, db: Session = Depends(get_db)):
    """在系统文件管理器中打开该数据版本的快照目录（优先 media）。"""
    service = DatasetService(DatasetVersionRepository(db))
    try:
        version = service.get_version(project_id, version_id)
    except RuntimeError as error:
        raise HTTPException(404, str(error)) from error

    root = version.snapshot_path
    target = root / "media" if (root / "media").is_dir() else root
    if not target.is_dir():
        raise HTTPException(404, "数据版本目录不存在")

    try:
        _reveal_directory(target)
    except subprocess.CalledProcessError as error:
        raise HTTPException(500, f"无法打开目录: {error}") from error

    return {"ok": True, "path": str(target)}

@router.get("/{version_id}", response_model=DatasetVersionDetailOut)
def get_dataset_version_detail(
    project_id: str,
    version_id: str,
    db: Session = Depends(get_db),
):
    service = DatasetService(DatasetVersionRepository(db))
    try:
        return DatasetVersionDetailOut.model_validate(service.detail(project_id, version_id))
    except RuntimeError as error:
        raise HTTPException(404, str(error)) from error
