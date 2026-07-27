"""Project API routes."""

from __future__ import annotations

import os
import shutil
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from server.api.schemas import (
    CategoryCreate,
    CategoryOut,
    ProjectCreate,
    ProjectOut,
    ProjectUpdate,
)
from server.db.database import get_db, project_dir
from server.db.models import Category, Frame, Project, Video

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
    categories = db.query(Category).filter(Category.project_id == project.id).order_by(Category.class_id).all()
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
    return [_project_out(db, p) for p in projects]


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
    db.query(Category).filter(Category.project_id == project_id).delete()
    for cat in categories:
        db.add(Category(
            project_id=project_id,
            class_id=cat.class_id,
            name=cat.name,
            description=cat.description,
            color=cat.color,
            required=cat.required,
        ))
    db.commit()
    cats = db.query(Category).filter(Category.project_id == project_id).order_by(Category.class_id).all()
    return [CategoryOut.model_validate(c) for c in cats]
