"""Immutable dataset version API."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from server.api.schemas import DatasetVersionCreate, DatasetVersionOut
from server.core.dataset_service import DatasetService, DatasetVersionRepository
from server.db.database import get_db
from server.db.models import DatasetVersion, Project

router = APIRouter(prefix="/api/projects/{project_id}/dataset-versions", tags=["datasets"])


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
):
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    service = DatasetService(DatasetVersionRepository(db))
    try:
        version = service.create_version(project.id, project.task_type, val_ratio=body.val_ratio)
        db.commit()
    except RuntimeError as error:
        db.rollback()
        raise HTTPException(400, str(error)) from error
    return db.get(DatasetVersion, version.id)
