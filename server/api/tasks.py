"""Task API routes."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from server.api.schemas import TaskCreate, TaskOut
from server.db.database import get_db
from server.db.models import Project, Task, TaskStatus
from server.worker.task_worker import TaskWorker

router = APIRouter(prefix="/api/projects/{project_id}/tasks", tags=["tasks"])


@router.get("", response_model=list[TaskOut])
def list_tasks(project_id: str, db: Session = Depends(get_db)):
    TaskWorker.reconcile_stale_tasks(db, project_id)
    tasks = db.query(Task).filter(Task.project_id == project_id).order_by(Task.created_at.desc()).all()
    return [TaskOut.model_validate(t) for t in tasks]


@router.post("", response_model=TaskOut)
def create_task(project_id: str, body: TaskCreate, db: Session = Depends(get_db)):
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    TaskWorker.reconcile_stale_tasks(db, project_id)
    if TaskWorker.is_running(project_id):
        raise HTTPException(409, "已有任务在运行")

    task = Task(
        project_id=project_id,
        task_type=body.task_type,
        params=body.params,
    )
    db.add(task)
    db.commit()
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
    task.log = (task.log + "\n用户请求停止，当前张处理完后终止…").strip()
    db.commit()
    return {"ok": True, "task_id": task.id}
