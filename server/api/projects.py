"""Project API routes."""

from __future__ import annotations

import os
import shutil
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import and_, func
from sqlalchemy.orm import Session

from server.api.schemas import (
    CategoryCreate,
    CategoryOut,
    ProjectCreate,
    ProjectOut,
    ProjectOverviewOut,
    ProjectUpdate,
)
from server.db.database import get_db, project_dir
from server.db.models import Annotation, Category, Frame, Project, Video

router = APIRouter(prefix="/api/projects", tags=["projects"])


def _disk_usage_mb(path: Path) -> float:
    total = 0
    if not path.exists():
        return 0.0
    for root, _dirs, files in os.walk(path):
        for f in files:
            try:
                total += (Path(root) / f).stat().st_size
            except OSError:
                pass
    return round(total / 1024 / 1024, 2)


def _project_out(db: Session, project: Project) -> ProjectOut:
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
        disk_usage_mb=_disk_usage_mb(project_dir(project.id)),
    )


@router.get("", response_model=list[ProjectOut])
def list_projects(db: Session = Depends(get_db)):
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
            disk_usage_mb=_disk_usage_mb(project_dir(project.id)),
        )
        for project in projects
    ]


@router.get("/overview", response_model=list[ProjectOverviewOut])
def list_project_overviews(db: Session = Depends(get_db)):
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
            disk_usage_mb=_disk_usage_mb(project_dir(project.id)),
        )
        stats = dict(stats_by_project.get(project.id, {}))
        stats["total"] = frame_counts.get(project.id, 0)
        overviews.append(ProjectOverviewOut(
            project=project_out,
            stats=stats,
            preview_frame_id=preview_by_project.get(project.id),
        ))
    return overviews


@router.post("", response_model=ProjectOut)
def create_project(body: ProjectCreate, db: Session = Depends(get_db)):
    project = Project(
        name=body.name,
        description=body.description,
        task_type=body.task_type,
        label_prompt=body.label_prompt,
        review_prompt=body.review_prompt,
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
    return _project_out(db, project)


@router.get("/{project_id}", response_model=ProjectOut)
def get_project(project_id: str, db: Session = Depends(get_db)):
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    return _project_out(db, project)


@router.patch("/{project_id}", response_model=ProjectOut)
def update_project(project_id: str, body: ProjectUpdate, db: Session = Depends(get_db)):
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(project, field, value)
    db.commit()
    db.refresh(project)
    return _project_out(db, project)


@router.delete("/{project_id}")
def delete_project(project_id: str, db: Session = Depends(get_db)):
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    path = project_dir(project_id)
    db.delete(project)
    db.commit()
    if path.exists():
        shutil.rmtree(path, ignore_errors=True)
    return {"ok": True}


@router.put("/{project_id}/categories", response_model=list[CategoryOut])
def set_categories(project_id: str, categories: list[CategoryCreate], db: Session = Depends(get_db)):
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
    return [CategoryOut.model_validate(c) for c in cats]
