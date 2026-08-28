"""Task API routes."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from server.api.schemas import GlobalTaskOut, TaskCreate, TaskOut
from server.db.database import get_db
from server.db.models import (
    Project,
    ProjectExecutionLease,
    PublicDatasetImport,
    Task,
    TaskStatus,
    TaskType,
)
from server.worker.task_worker import TaskWorker

router = APIRouter(prefix="/api/projects/{project_id}/tasks", tags=["tasks"])
global_router = APIRouter(prefix="/api/tasks", tags=["tasks"])


@global_router.get("", response_model=list[GlobalTaskOut])
def list_all_tasks(db: Session = Depends(get_db)):
    rows = (
        db.query(Task, Project.name)
        .join(Project, Project.id == Task.project_id)
        .order_by(Task.created_at.desc())
        .all()
    )
    return [
        GlobalTaskOut(**TaskOut.model_validate(task).model_dump(), project_name=project_name)
        for task, project_name in rows
    ]


@router.get("", response_model=list[TaskOut])
def list_tasks(project_id: str, db: Session = Depends(get_db)):
    tasks = db.query(Task).filter(Task.project_id == project_id).order_by(Task.created_at.desc()).all()
    return [TaskOut.model_validate(t) for t in tasks]


@router.post("", response_model=TaskOut)
def create_task(project_id: str, body: TaskCreate, db: Session = Depends(get_db)):
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    task = Task(
        project_id=project_id,
        task_type=body.task_type,
        params=body.params,
    )
    db.add(task)
    db.flush()
    db.add(ProjectExecutionLease(project_id=project_id, task_id=task.id))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "该项目已有任务占用执行租约") from None
    db.refresh(task)
    TaskWorker.start(task.id)
    return TaskOut.model_validate(task)


@router.get("/{task_id}", response_model=TaskOut)
def get_task(project_id: str, task_id: str, db: Session = Depends(get_db)):
    task = db.get(Task, task_id)
    if not task or task.project_id != project_id:
        raise HTTPException(404, "Task not found")
    return TaskOut.model_validate(task)


@router.post("/{task_id}/cancel")
def cancel_task(project_id: str, task_id: str, db: Session = Depends(get_db)):
    task = db.get(Task, task_id)
    if not task or task.project_id != project_id:
        raise HTTPException(404, "Task not found")
    if task.status != TaskStatus.RUNNING:
        raise HTTPException(400, "任务未在运行")
    TaskWorker.cancel(task_id)
    task.cancel_requested = True
    task.log = (task.log + "\n用户请求停止，当前张处理完后终止…").strip()
    db.commit()
    return {"ok": True}


@router.post("/cancel-running")
def cancel_running_task(project_id: str, db: Session = Depends(get_db)):
    """停止当前项目正在运行的任务（标注/审查等）。"""
    task = (
        db.query(Task)
        .filter(Task.project_id == project_id, Task.status == TaskStatus.RUNNING)
        .order_by(Task.started_at.desc())
        .first()
    )
    if not task:
        raise HTTPException(404, "没有正在运行的任务")
    TaskWorker.cancel(task.id)
    task.cancel_requested = True
    task.log = (task.log + "\n用户请求停止，当前张处理完后终止…").strip()
    db.commit()
    return {"ok": True, "task_id": task.id}


@router.post("/{task_id}/retry", response_model=TaskOut)
def retry_task(project_id: str, task_id: str, db: Session = Depends(get_db)):
    original = db.get(Task, task_id)
    if not original or original.project_id != project_id:
        raise HTTPException(404, "Task not found")
    if original.status not in {
        TaskStatus.FAILED,
        TaskStatus.CANCELLED,
        TaskStatus.INTERRUPTED,
    }:
        raise HTTPException(400, "仅失败、取消或中断任务可以重试")
    retry = Task(
        project_id=project_id,
        task_type=original.task_type,
        params=dict(original.params),
        retry_of_task_id=original.id,
    )
    db.add(retry)
    db.flush()
    db.add(ProjectExecutionLease(project_id=project_id, task_id=retry.id))
    import_id = str(retry.params.get("import_id") or "")
    public_import = db.get(PublicDatasetImport, import_id) if import_id else None
    if public_import and original.task_type == TaskType.PUBLIC_FETCH:
        public_import.fetch_task_id = retry.id
    elif public_import and original.task_type == TaskType.PUBLIC_IMPORT:
        public_import.import_task_id = retry.id
    if original.task_type == TaskType.TRAIN:
        linked_import = (
            db.query(PublicDatasetImport)
            .filter(PublicDatasetImport.train_task_id == original.id)
            .first()
        )
        if linked_import:
            linked_import.train_task_id = retry.id
            linked_import.state = "training"
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "该项目已有任务占用执行租约") from None
    db.refresh(retry)
    TaskWorker.start(retry.id)
    return TaskOut.model_validate(retry)
