"""Project API routes."""

from __future__ import annotations

import os
import shutil
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import and_, case, func
from sqlalchemy.orm import Session

from server.api.deps import get_optional_actor
from server.api.schemas import (
    CategoryCreate,
    CategoryOut,
    ProjectCreate,
    ProjectCoverOut,
    ProjectDashboardOut,
    ProjectDashboardSummaryOut,
    ProjectDiskUsageOut,
    ProjectOut,
    ProjectOverviewOut,
    ProjectUpdate,
)
from server.core.audit import record_audit
from server.db.database import get_db, project_dir
from server.db.models import Annotation, Category, Frame, FrameStatus, ModelVersion, Project, Task, TaskStatus, Video
from server.services.user_service import UserService
from server.services.project_cover_service import PROJECT_COVER_MAX_BYTES, project_cover_service

router = APIRouter(prefix="/api/projects", tags=["projects"])

_DISK_USAGE_CACHE_TTL_SECONDS = 60.0
_disk_usage_cache: dict[Path, tuple[float, float]] = {}
_disk_usage_cache_lock = threading.Lock()


def _disk_usage_mb(path: Path) -> float:
    cache_key = path.resolve()
    now = time.monotonic()
    with _disk_usage_cache_lock:
        cached = _disk_usage_cache.get(cache_key)
        if cached and now - cached[0] < _DISK_USAGE_CACHE_TTL_SECONDS:
            return cached[1]

        total = 0
        if path.exists():
            for root, _dirs, files in os.walk(path):
                for filename in files:
                    try:
                        total += os.path.getsize(os.path.join(root, filename))
                    except OSError:
                        continue
        result = round(total / 1024 / 1024, 2)
        _disk_usage_cache[cache_key] = (time.monotonic(), result)
        return result


def _project_out(db: Session, project: Project, *, include_disk_usage: bool = True) -> ProjectOut:
    frame_count = db.query(Frame).filter(Frame.project_id == project.id).count()
    video_count = db.query(Video).filter(Video.project_id == project.id).count()
    categories = db.query(Category).filter(Category.project_id == project.id).order_by(Category.sort_order, Category.class_id).all()
    return ProjectOut(
        id=project.id,
        name=project.name,
        description=project.description,
        task_type=project.task_type,
        label_prompt=project.label_prompt,
        review_prompt=project.review_prompt,
        created_at=project.created_at,
        updated_at=project.updated_at,
        categories=[CategoryOut.model_validate(c) for c in categories],
        frame_count=frame_count,
        video_count=video_count,
        disk_usage_mb=_disk_usage_mb(project_dir(project.id)) if include_disk_usage else 0.0,
        has_custom_cover=project_cover_service.has_cover(project.id),
    )


@router.get("", response_model=list[ProjectOut])
def list_projects(db: Session = Depends(get_db), include_disk_usage: bool = True):
    projects = db.query(Project).order_by(Project.updated_at.desc()).all()
    frame_counts = dict(db.query(Frame.project_id, func.count(Frame.id)).group_by(Frame.project_id).all())
    video_counts = dict(db.query(Video.project_id, func.count(Video.id)).group_by(Video.project_id).all())
    categories_by_project: dict[str, list[Category]] = {}
    for category in db.query(Category).order_by(Category.project_id, Category.sort_order, Category.class_id).all():
        categories_by_project.setdefault(category.project_id, []).append(category)
    return [
        ProjectOut(
            id=project.id,
            name=project.name,
            description=project.description,
            task_type=project.task_type,
            label_prompt=project.label_prompt,
            review_prompt=project.review_prompt,
            created_at=project.created_at,
            updated_at=project.updated_at,
            categories=[CategoryOut.model_validate(category) for category in categories_by_project.get(project.id, [])],
            frame_count=frame_counts.get(project.id, 0),
            video_count=video_counts.get(project.id, 0),
            disk_usage_mb=_disk_usage_mb(project_dir(project.id)) if include_disk_usage else 0.0,
            has_custom_cover=project_cover_service.has_cover(project.id),
        )
        for project in projects
    ]


@router.get("/overview", response_model=list[ProjectOverviewOut])
def list_project_overviews(db: Session = Depends(get_db), include_disk_usage: bool = True):
    """Return dashboard data with a bounded number of aggregate queries."""
    projects = db.query(Project).order_by(Project.updated_at.desc()).all()
    frame_counts = dict(db.query(Frame.project_id, func.count(Frame.id)).group_by(Frame.project_id).all())
    video_counts = dict(db.query(Video.project_id, func.count(Video.id)).group_by(Video.project_id).all())
    categories_by_project: dict[str, list[Category]] = {}
    for category in db.query(Category).order_by(Category.project_id, Category.sort_order, Category.class_id).all():
        categories_by_project.setdefault(category.project_id, []).append(category)

    stats_by_project: dict[str, dict[str, int]] = {}
    for project_id, status, count in (
        db.query(Frame.project_id, Frame.status, func.count(Frame.id))
        .group_by(Frame.project_id, Frame.status)
        .all()
    ):
        stats_by_project.setdefault(project_id, {})[status.value] = count

    latest_created_at = (
        db.query(
            Frame.project_id.label("project_id"),
            func.max(Frame.created_at).label("created_at"),
        )
        .group_by(Frame.project_id)
        .subquery()
    )
    preview_by_project = dict(
        db.query(Frame.project_id, func.min(Frame.id))
        .join(
            latest_created_at,
            and_(
                latest_created_at.c.project_id == Frame.project_id,
                latest_created_at.c.created_at == Frame.created_at,
            ),
        )
        .group_by(Frame.project_id)
        .all()
    )

    model_rows = db.query(
        ModelVersion.project_id,
        func.count(ModelVersion.id),
        func.max(ModelVersion.version),
    ).group_by(ModelVersion.project_id).all()
    model_counts = {project_id: count for project_id, count, _version in model_rows}
    latest_model_versions = {project_id: version for project_id, _count, version in model_rows}

    task_rows = db.query(
        Task.project_id,
        func.count(Task.id),
        func.sum(case((Task.status == TaskStatus.COMPLETED, 1), else_=0)),
    ).group_by(Task.project_id).all()
    task_counts = {project_id: count for project_id, count, _completed in task_rows}
    completed_task_counts = {project_id: int(completed or 0) for project_id, _count, completed in task_rows}

    video_hours = {
        project_id: round(float(duration or 0) / 3600, 2)
        for project_id, duration in db.query(Video.project_id, func.sum(Video.duration_sec))
        .group_by(Video.project_id)
        .all()
    }
    reviewed_statuses = (FrameStatus.HUMAN_OK, FrameStatus.HUMAN_WRONG, FrameStatus.NO_TARGET)
    reviewed_projects = {
        project_id
        for (project_id,) in db.query(Frame.project_id)
        .filter(Frame.status.in_(reviewed_statuses))
        .distinct()
        .all()
    }
    active_member_count = UserService(db).count_active_annotators()

    overviews: list[ProjectOverviewOut] = []
    for project in projects:
        project_out = ProjectOut(
            id=project.id,
            name=project.name,
            description=project.description,
            task_type=project.task_type,
            label_prompt=project.label_prompt,
            review_prompt=project.review_prompt,
            created_at=project.created_at,
            updated_at=project.updated_at,
            categories=[CategoryOut.model_validate(category) for category in categories_by_project.get(project.id, [])],
            frame_count=frame_counts.get(project.id, 0),
            video_count=video_counts.get(project.id, 0),
            disk_usage_mb=_disk_usage_mb(project_dir(project.id)) if include_disk_usage else 0.0,
            has_custom_cover=project_cover_service.has_cover(project.id),
        )
        stats = dict(stats_by_project.get(project.id, {}))
        stats["total"] = frame_counts.get(project.id, 0)
        overviews.append(ProjectOverviewOut(
            project=project_out,
            created_by=project.created_by,
            stats=stats,
            preview_frame_id=preview_by_project.get(project.id),
            model_count=model_counts.get(project.id, 0),
            latest_model_version=latest_model_versions.get(project.id),
            task_count=task_counts.get(project.id, 0),
            completed_task_count=completed_task_counts.get(project.id, 0),
            total_video_hours=video_hours.get(project.id, 0.0),
            active_annotators=active_member_count if project.id in reviewed_projects else 0,
        ))
    return overviews


@router.get("/dashboard", response_model=ProjectDashboardOut)
def get_project_dashboard(db: Session = Depends(get_db), include_disk_usage: bool = True):
    """Return the complete project-management view model in one request."""
    projects = list_project_overviews(db, include_disk_usage=include_disk_usage)
    since = datetime.now(timezone.utc) - timedelta(days=30)
    total_video_seconds = db.query(func.sum(Video.duration_sec)).scalar() or 0
    recent_video_seconds = db.query(func.sum(Video.duration_sec)).filter(Video.created_at >= since).scalar() or 0
    recent_data_items = db.query(func.count(Frame.id)).filter(Frame.created_at >= since).scalar() or 0
    recent_completed_tasks = db.query(func.count(Task.id)).filter(
        Task.status == TaskStatus.COMPLETED,
        Task.finished_at >= since,
    ).scalar() or 0
    active_annotators = UserService(db).count_active_annotators()
    return ProjectDashboardOut(
        summary=ProjectDashboardSummaryOut(
            total_projects=len(projects),
            total_data_items=sum(project.project.frame_count for project in projects),
            active_annotators=active_annotators,
            total_video_hours=round(float(total_video_seconds) / 3600, 2),
            projects_last_30_days=db.query(func.count(Project.id)).filter(Project.created_at >= since).scalar() or 0,
            data_items_last_30_days=int(recent_data_items),
            completed_tasks_last_30_days=int(recent_completed_tasks),
            video_hours_last_30_days=round(float(recent_video_seconds) / 3600, 2),
        ),
        projects=projects,
    )


@router.post("", response_model=ProjectOut)
def create_project(body: ProjectCreate, db: Session = Depends(get_db), actor: str = Depends(get_optional_actor)):
    project = Project(
        name=body.name,
        description=body.description,
        task_type=body.task_type,
        label_prompt=body.label_prompt,
        review_prompt=body.review_prompt,
        created_by=actor,
    )
    db.add(project)
    db.flush()
    project_dir(project.id)

    for cat in body.categories:
        db.add(Category(
            project_id=project.id,
            class_id=cat.class_id,
            name=cat.name,
            description=cat.description,
            color=cat.color,
            required=cat.required,
            sort_order=cat.sort_order,
        ))
    db.commit()
    db.refresh(project)
    record_audit(
        db,
        actor=actor,
        action="project.create",
        resource_type="project",
        resource_id=project.id,
        project_id=project.id,
        summary=f"创建项目：{project.name}",
        metadata={"task_type": project.task_type.value},
    )
    return _project_out(db, project)


@router.get("/{project_id}", response_model=ProjectOut)
def get_project(project_id: str, db: Session = Depends(get_db), include_disk_usage: bool = True):
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    return _project_out(db, project, include_disk_usage=include_disk_usage)


@router.get("/{project_id}/disk-usage", response_model=ProjectDiskUsageOut)
def get_project_disk_usage(project_id: str, db: Session = Depends(get_db)):
    if db.get(Project, project_id) is None:
        raise HTTPException(404, "Project not found")
    return ProjectDiskUsageOut(disk_usage_mb=_disk_usage_mb(project_dir(project_id)))


@router.get("/{project_id}/cover")
def get_project_cover(project_id: str, db: Session = Depends(get_db)):
    if db.get(Project, project_id) is None:
        raise HTTPException(404, "Project not found")
    cover = project_cover_service.get_cover(project_id)
    if cover is None:
        raise HTTPException(404, "Project cover not found")
    return FileResponse(
        cover.path,
        media_type="image/jpeg",
        headers={"Cache-Control": "private, max-age=300"},
    )


@router.post("/{project_id}/cover", response_model=ProjectCoverOut)
async def upload_project_cover(
    project_id: str,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    actor: str = Depends(get_optional_actor),
):
    project = db.get(Project, project_id)
    if project is None:
        await file.close()
        raise HTTPException(404, "Project not found")
    try:
        content = await file.read(PROJECT_COVER_MAX_BYTES + 1)
    finally:
        await file.close()
    try:
        project_cover_service.save_cover(project_id, file.filename or "cover", content)
    except ValueError as error:
        raise HTTPException(400, str(error)) from error

    project.updated_at = datetime.now(timezone.utc)
    db.commit()
    record_audit(
        db,
        actor=actor,
        action="project.cover.update",
        resource_type="project",
        resource_id=project_id,
        project_id=project_id,
        summary=f"更新项目封面：{project.name}",
        metadata={"filename": Path(file.filename or "cover").name, "bytes": len(content)},
    )
    return ProjectCoverOut(
        cover_url=f"/api/projects/{project_id}/cover",
        has_custom_cover=True,
    )


@router.patch("/{project_id}", response_model=ProjectOut)
def update_project(project_id: str, body: ProjectUpdate, db: Session = Depends(get_db), actor: str = Depends(get_optional_actor)):
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(project, field, value)
    db.commit()
    db.refresh(project)
    record_audit(
        db,
        actor=actor,
        action="project.update",
        resource_type="project",
        resource_id=project.id,
        project_id=project.id,
        summary=f"更新项目：{project.name}",
        metadata=body.model_dump(exclude_unset=True),
    )
    return _project_out(db, project)


@router.delete("/{project_id}")
def delete_project(project_id: str, db: Session = Depends(get_db), actor: str = Depends(get_optional_actor)):
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    project_name = project.name
    path = project_dir(project_id)
    db.delete(project)
    db.commit()
    if path.exists():
        shutil.rmtree(path, ignore_errors=True)
    record_audit(
        db,
        actor=actor,
        action="project.delete",
        resource_type="project",
        resource_id=project_id,
        project_id=project_id,
        summary=f"删除项目：{project_name}",
    )
    return {"ok": True}


@router.put("/{project_id}/categories", response_model=list[CategoryOut])
def set_categories(
    project_id: str,
    categories: list[CategoryCreate],
    db: Session = Depends(get_db),
    actor: str = Depends(get_optional_actor),
):
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    class_ids = [category.class_id for category in categories]
    names = [category.name.strip() for category in categories]
    if len(class_ids) != len(set(class_ids)) or len(names) != len(set(names)):
        raise HTTPException(400, "类别 ID 和名称必须唯一")
    if any(class_id < 0 for class_id in class_ids):
        raise HTTPException(400, "类别 ID 不能为负数")
    if any(not name or Path(name).name != name or name in {".", ".."} for name in names):
        raise HTTPException(400, "类别名称不能为空或包含路径字符")

    existing = {
        category.class_id: category
        for category in db.query(Category).filter(Category.project_id == project_id).all()
    }
    referenced = {
        class_id
        for (class_id,) in db.query(Annotation.class_id)
        .join(Frame, Frame.id == Annotation.frame_id)
        .filter(Frame.project_id == project_id)
        .distinct()
        .all()
    }
    removed_referenced = referenced - set(class_ids)
    if removed_referenced:
        raise HTTPException(409, f"已有标注引用类别 ID，不能删除或改号: {sorted(removed_referenced)}")

    for request_category in categories:
        category = existing.pop(request_category.class_id, None)
        if category is None:
            category = Category(project_id=project_id, class_id=request_category.class_id)
            db.add(category)
        category.name = request_category.name.strip()
        category.description = request_category.description
        category.color = request_category.color
        category.required = request_category.required
        category.sort_order = request_category.sort_order
    for category in existing.values():
        db.delete(category)
    db.commit()
    cats = db.query(Category).filter(Category.project_id == project_id).order_by(Category.sort_order, Category.class_id).all()
    record_audit(
        db,
        actor=actor,
        action="project.categories.update",
        resource_type="project",
        resource_id=project_id,
        project_id=project_id,
        summary=f"更新项目类别：{project.name}",
        metadata={"category_count": len(cats)},
    )
    return [CategoryOut.model_validate(c) for c in cats]
