"""Unified project material inventory API."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError

from server.api.deps import get_optional_actor
from server.api.schemas import (
    MaterialBatchMutationOut,
    MaterialBatchOut,
    MaterialFrameItemOut,
    MaterialFramePageOut,
    MaterialInventoryOut,
    MaterialInventorySummaryOut,
)
from server.core.audit import record_audit
from server.db.database import get_db
from server.db.models import Project, ProjectExecutionLease
from server.repositories.material_repository import MaterialRepository


router = APIRouter(prefix="/api/projects/{project_id}/material-batches", tags=["materials"])


def _batch_out(item) -> MaterialBatchOut:
    return MaterialBatchOut(
        id=item.id,
        project_id=item.project_id,
        origin=item.origin,
        title=item.title,
        status=item.status,
        frame_count=item.frame_count,
        usable_frame_count=item.usable_frame_count,
        pending_frame_count=item.pending_frame_count,
        frame_status_counts=item.frame_status_counts,
        preview_frame_ids=list(item.preview_frame_ids),
        metadata=item.metadata,
        archived_at=item.archived_at,
        created_at=item.created_at,
        updated_at=item.updated_at,
        next_action=item.next_action,
    )


@router.get("", response_model=MaterialInventoryOut)
def list_material_batches(
    project_id: str,
    include_archived: bool = False,
    origin: str = "",
    status: str = "",
    query: str = "",
    db: Session = Depends(get_db),
):
    if not db.get(Project, project_id):
        raise HTTPException(404, "Project not found")
    inventory = MaterialRepository(db).inventory(
        project_id,
        include_archived=include_archived,
        origin=origin,
        status=status,
        query=query,
    )
    return MaterialInventoryOut(
        summary=MaterialInventorySummaryOut.model_validate(inventory.summary),
        items=[_batch_out(item) for item in inventory.items],
    )


@router.get("/{batch_id}/frames", response_model=MaterialFramePageOut)
def list_material_batch_frames(
    project_id: str,
    batch_id: str,
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=40, ge=1, le=100),
    db: Session = Depends(get_db),
):
    try:
        page = MaterialRepository(db).frame_page(project_id, batch_id, offset=offset, limit=limit)
    except RuntimeError as error:
        raise HTTPException(404, str(error)) from error
    return MaterialFramePageOut(
        items=[MaterialFrameItemOut.model_validate(item) for item in page.items],
        total=page.total,
        offset=page.offset,
        limit=page.limit,
    )


@router.post("/{batch_id}/archive", response_model=MaterialBatchMutationOut)
def archive_material_batch(
    project_id: str,
    batch_id: str,
    db: Session = Depends(get_db),
    actor: str = Depends(get_optional_actor),
):
    repository = MaterialRepository(db)
    if not repository.get(project_id, batch_id):
        raise HTTPException(404, "素材批次不存在")
    try:
        lease = ProjectExecutionLease(project_id=project_id, task_id=f"material-archive-{uuid.uuid4()}")
        db.add(lease)
        db.flush()
        batch = repository.archive(project_id, batch_id, lease_task_id=lease.task_id)
        db.commit()
        db.refresh(batch)
        db.delete(lease)
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "项目存在运行中任务，请等待任务结束后再归档") from None
    except RuntimeError as error:
        db.rollback()
        raise HTTPException(409, str(error)) from error
    record_audit(
        db,
        actor=actor,
        action="material.batch.archive",
        resource_type="material_batch",
        resource_id=batch.id,
        project_id=project_id,
        summary=f"归档素材批次：{batch.title}",
    )
    return MaterialBatchMutationOut(id=batch.id, archived_at=batch.archived_at)


@router.post("/{batch_id}/restore", response_model=MaterialBatchMutationOut)
def restore_material_batch(
    project_id: str,
    batch_id: str,
    db: Session = Depends(get_db),
    actor: str = Depends(get_optional_actor),
):
    repository = MaterialRepository(db)
    if not repository.get(project_id, batch_id):
        raise HTTPException(404, "素材批次不存在")
    try:
        lease = ProjectExecutionLease(project_id=project_id, task_id=f"material-restore-{uuid.uuid4()}")
        db.add(lease)
        db.flush()
        batch = repository.restore(project_id, batch_id, lease_task_id=lease.task_id)
        db.commit()
        db.refresh(batch)
        db.delete(lease)
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "项目存在运行中任务，请等待任务结束后再恢复") from None
    except RuntimeError as error:
        db.rollback()
        raise HTTPException(409, str(error)) from error
    record_audit(
        db,
        actor=actor,
        action="material.batch.restore",
        resource_type="material_batch",
        resource_id=batch.id,
        project_id=project_id,
        summary=f"恢复素材批次：{batch.title}",
    )
    return MaterialBatchMutationOut(id=batch.id, archived_at=batch.archived_at)
