"""审计日志查询 API。"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, Query
from sqlalchemy import or_
from sqlalchemy.orm import Session

from server.api.deps import get_current_user
from server.api.schemas import AuditLogListOut, AuditLogOut
from server.db.database import get_db
from server.db.models import AuditLog, Project
from server.services.user_service import UserDTO

router = APIRouter(prefix="/api/audit", tags=["audit"])


@router.get("", response_model=AuditLogListOut)
def list_audit_logs(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    action: str = Query(default=""),
    project_id: str = Query(default=""),
    q: str = Query(default=""),
    from_time: datetime | None = Query(default=None, alias="from"),
    to_time: datetime | None = Query(default=None, alias="to"),
    _user: UserDTO = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    query = db.query(AuditLog)
    if action:
        query = query.filter(AuditLog.action == action)
    if project_id:
        query = query.filter(AuditLog.project_id == project_id)
    if from_time:
        query = query.filter(AuditLog.created_at >= from_time)
    if to_time:
        query = query.filter(AuditLog.created_at <= to_time)
    keyword = q.strip()
    if keyword:
        like = f"%{keyword}%"
        query = query.filter(
            or_(
                AuditLog.summary.like(like),
                AuditLog.actor.like(like),
                AuditLog.action.like(like),
            )
        )

    total = query.count()
    rows = (
        query.order_by(AuditLog.created_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )

    project_names: dict[str, str] = {}
    project_ids = {row.project_id for row in rows if row.project_id}
    if project_ids:
        project_names = dict(
            db.query(Project.id, Project.name).filter(Project.id.in_(project_ids)).all()
        )

    items = [
        AuditLogOut(
            id=row.id,
            created_at=row.created_at,
            actor=row.actor,
            action=row.action,
            resource_type=row.resource_type,
            resource_id=row.resource_id,
            project_id=row.project_id,
            project_name=project_names.get(row.project_id or "", None),
            summary=row.summary,
            metadata=row.metadata_json or {},
            ip=row.ip,
        )
        for row in rows
    ]
    return AuditLogListOut(items=items, total=total, page=page, page_size=page_size)
