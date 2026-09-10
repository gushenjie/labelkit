"""Task API routes."""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from server.api.deps import get_optional_actor
from server.api.schemas import GlobalTaskOut, TaskCreate, TaskOut, TrainResumeRequest
from server.core.audit import record_audit
from server.core.train_resume import can_resume_train_task, resolve_resume_checkpoint
from server.db.database import get_db
from server.db.models import (
    Project,
    ProjectExecutionLease,
    MaterialBatch,
    MaterialOrigin,
    PublicDatasetImport,
    Task,
    TaskStatus,
    TaskType,
)
from server.repositories.material_repository import MaterialRepository
from server.services.material_readiness_service import (
    MaterialReadinessError,
    MaterialReadinessService,
    readiness_error_detail,
)
from server.worker.task_worker import TaskWorker

router = APIRouter(prefix="/api/projects/{project_id}/tasks", tags=["tasks"])
global_router = APIRouter(prefix="/api/tasks", tags=["tasks"])


def _task_last_activity(task: Task) -> datetime:
    """最近有效活动时间：完成 > 开始 > 创建；不含 heartbeat，避免列表跳动。"""
    return task.finished_at or task.started_at or task.created_at


def _resume_source_id(task: Task) -> str | None:
    params = task.params or {}
    source = str(params.get("resume_from_task_id") or "").strip()
    if source:
        return source
    if params.get("resume") and task.retry_of_task_id:
        return task.retry_of_task_id
    return None


def _task_out(task: Task, *, latest_resume_task_id: str | None = None) -> TaskOut:
    payload = TaskOut.model_validate(task).model_dump()
    payload["can_resume"] = can_resume_train_task(
        task.project_id,
        task.id,
        status=task.status.value if hasattr(task.status, "value") else str(task.status),
        task_type=task.task_type.value if hasattr(task.task_type, "value") else str(task.task_type),
        params=task.params if isinstance(task.params, dict) else {},
        retry_of_task_id=task.retry_of_task_id,
    )
    payload["last_activity_at"] = _task_last_activity(task)
    payload["resume_from_task_id"] = _resume_source_id(task)
    payload["latest_resume_task_id"] = latest_resume_task_id
    return TaskOut(**payload)


def _latest_resume_map(tasks: list[Task]) -> dict[str, str]:
    """来源任务 -> 最近一次续训尝试（按活动时间，调用方应已按活动时间倒序）。"""
    mapping: dict[str, str] = {}
    for task in tasks:
        source = _resume_source_id(task)
        if source and source not in mapping:
            mapping[source] = task.id
    return mapping


@global_router.get("", response_model=list[GlobalTaskOut])
def list_all_tasks(db: Session = Depends(get_db)):
    activity = func.coalesce(Task.finished_at, Task.started_at, Task.created_at)
    rows = (
        db.query(Task, Project.name)
        .join(Project, Project.id == Task.project_id)
        .order_by(activity.desc(), Task.created_at.desc())
        .all()
    )
    tasks = [task for task, _ in rows]
    latest_resume_by_source = _latest_resume_map(tasks)
    result = []
    for task, project_name in rows:
        assignee = str(task.params.get("assignee") or "自动流水线").strip()
        priority = str(task.params.get("priority") or "").strip().lower()
        if priority not in {"high", "medium", "low"}:
            if task.status in {TaskStatus.FAILED, TaskStatus.INTERRUPTED}:
                priority = "high"
            elif task.status in {TaskStatus.RUNNING, TaskStatus.PAUSED}:
                priority = "medium"
            else:
                priority = "low"
        result.append(
            GlobalTaskOut(
                **_task_out(
                    task,
                    latest_resume_task_id=latest_resume_by_source.get(task.id),
                ).model_dump(),
                project_name=project_name,
                assignee=assignee,
                priority=priority,
            )
        )
    return result


@router.get("", response_model=list[TaskOut])
def list_tasks(project_id: str, db: Session = Depends(get_db)):
    activity = func.coalesce(Task.finished_at, Task.started_at, Task.created_at)
    tasks = (
        db.query(Task)
        .filter(Task.project_id == project_id)
        .order_by(activity.desc(), Task.created_at.desc())
        .all()
    )
    latest_resume_by_source = _latest_resume_map(tasks)
    return [
        _task_out(task, latest_resume_task_id=latest_resume_by_source.get(task.id))
        for task in tasks
    ]

@router.post("", response_model=TaskOut)
def create_task(
    project_id: str,
    body: TaskCreate,
    db: Session = Depends(get_db),
    actor: str = Depends(get_optional_actor),
):
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    params = dict(body.params)
    if body.task_type in {TaskType.TRAIN, TaskType.EXPORT, TaskType.DATASET_SNAPSHOT} and not params.get(
        "dataset_version_id"
    ):
        try:
            MaterialReadinessService(MaterialRepository(db)).assert_current_pool_ready(project_id)
        except MaterialReadinessError as error:
            raise HTTPException(409, readiness_error_detail(error)) from error

    batch = None
    if body.task_type in {TaskType.IMPORT, TaskType.DERIVE_CLASSIFY} and not params.get("material_batch_id"):
        origin = (
            MaterialOrigin.DATASET_IMPORT
            if body.task_type == TaskType.IMPORT
            else MaterialOrigin.DERIVED
        )
        title = str(params.get("title") or ("已有数据集导入" if origin == MaterialOrigin.DATASET_IMPORT else "派生素材"))
        batch = MaterialBatch(
            project_id=project_id,
            origin=origin,
            title=title,
            metadata_json={"task_type": body.task_type.value},
        )
        db.add(batch)
        db.flush()
        params["material_batch_id"] = batch.id
    task = Task(
        project_id=project_id,
        task_type=body.task_type,
        params=params,
    )
    if body.task_type == TaskType.EXTRACT:
        running_extract = (
            db.query(Task)
            .filter(
                Task.project_id == project_id,
                Task.task_type == TaskType.EXTRACT,
                Task.status.in_({TaskStatus.PENDING, TaskStatus.RUNNING}),
            )
            .first()
        )
        if running_extract:
            raise HTTPException(409, "已有提取任务正在执行，请等待完成后再试")
    db.add(task)
    db.flush()
    if batch is not None:
        batch.metadata_json = {**batch.metadata_json, "task_id": task.id}
    db.add(ProjectExecutionLease(project_id=project_id, task_id=task.id))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "该项目已有任务占用执行租约") from None
    db.refresh(task)
    TaskWorker.start(task.id)
    record_audit(
        db,
        actor=actor,
        action="task.create",
        resource_type="task",
        resource_id=task.id,
        project_id=project_id,
        summary=f"创建任务：{task.task_type.value}",
        metadata={"task_type": task.task_type.value},
    )
    return _task_out(task)


@router.get("/{task_id}", response_model=TaskOut)
def get_task(project_id: str, task_id: str, db: Session = Depends(get_db)):
    task = db.get(Task, task_id)
    if not task or task.project_id != project_id:
        raise HTTPException(404, "Task not found")
    return _task_out(task)


@router.post("/{task_id}/cancel")
def cancel_task(
    project_id: str,
    task_id: str,
    db: Session = Depends(get_db),
    actor: str = Depends(get_optional_actor),
):
    task = db.get(Task, task_id)
    if not task or task.project_id != project_id:
        raise HTTPException(404, "Task not found")
    if task.status != TaskStatus.RUNNING:
        raise HTTPException(400, "任务未在运行")
    TaskWorker.cancel(task_id)
    task.cancel_requested = True
    task.log = (task.log + "\n用户请求停止，当前张处理完后终止…").strip()
    db.commit()
    record_audit(
        db,
        actor=actor,
        action="task.cancel",
        resource_type="task",
        resource_id=task_id,
        project_id=project_id,
        summary=f"取消任务：{task.task_type.value}",
    )
    return {"ok": True}


@router.post("/cancel-running")
def cancel_running_task(
    project_id: str,
    db: Session = Depends(get_db),
    actor: str = Depends(get_optional_actor),
):
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
    record_audit(
        db,
        actor=actor,
        action="task.cancel",
        resource_type="task",
        resource_id=task.id,
        project_id=project_id,
        summary=f"取消运行中任务：{task.task_type.value}",
    )
    return {"ok": True, "task_id": task.id}


@router.post("/{task_id}/retry", response_model=TaskOut)
def retry_task(
    project_id: str,
    task_id: str,
    db: Session = Depends(get_db),
    actor: str = Depends(get_optional_actor),
):
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
    record_audit(
        db,
        actor=actor,
        action="task.retry",
        resource_type="task",
        resource_id=retry.id,
        project_id=project_id,
        summary=f"重试任务：{retry.task_type.value}",
        metadata={"retry_of_task_id": original.id},
    )
    return _task_out(retry)


_RESUME_LOCKED_KEYS = frozenset(
    {
        "resume",
        "resume_from_task_id",
        "resume_of",
        "base_model",
        "dataset_version_id",
        "val_ratio",
    }
)
_RESUME_OVERRIDE_KEYS = frozenset(
    {
        "epochs",
        "imgsz",
        "batch",
        "device",
        "workers",
        "patience",
        "lr0",
        "optimizer",
        "seed",
        "close_mosaic",
        "weight_decay",
        "warmup_epochs",
    }
)


@router.post("/{task_id}/resume", response_model=TaskOut)
def resume_train_task(
    project_id: str,
    task_id: str,
    body: TrainResumeRequest | None = None,
    db: Session = Depends(get_db),
    actor: str = Depends(get_optional_actor),
):
    """从中断/失败训练任务的 last.pt 断点续训。"""
    original = db.get(Task, task_id)
    if not original or original.project_id != project_id:
        raise HTTPException(404, "Task not found")
    if original.task_type != TaskType.TRAIN:
        raise HTTPException(400, "仅训练任务支持续训")
    if original.status not in {TaskStatus.FAILED, TaskStatus.INTERRUPTED}:
        raise HTTPException(400, "仅中断或失败的训练任务可以续训")
    resolved = resolve_resume_checkpoint(
        project_id,
        original.id,
        params=original.params if isinstance(original.params, dict) else {},
        retry_of_task_id=original.retry_of_task_id,
    )
    if resolved is None:
        raise HTTPException(400, "未找到可续训权重 last.pt，请重新开始训练")
    checkpoint, checkpoint_owner_id = resolved

    params = dict(original.params)
    overrides = dict((body.params if body else {}) or {})
    for key, value in overrides.items():
        if key in _RESUME_LOCKED_KEYS:
            continue
        if key not in _RESUME_OVERRIDE_KEYS:
            continue
        params[key] = value

    params["resume"] = True
    # 断点目录始终指向持有 last.pt 的源头运行，避免续训链找不到权重
    params["resume_from_task_id"] = checkpoint_owner_id
    params["base_model"] = str(checkpoint)
    params.pop("resume_of", None)

    try:
        epochs = int(params.get("epochs") or original.total or 0)
    except (TypeError, ValueError) as exc:
        raise HTTPException(400, "训练轮数无效") from exc
    progress = max(0, int(original.progress or 0))
    if epochs < max(1, progress):
        raise HTTPException(400, f"训练轮数需不小于当前进度 {progress}")

    resume_task = Task(
        project_id=project_id,
        task_type=TaskType.TRAIN,
        params=params,
        retry_of_task_id=original.id,
        progress=progress,
        total=epochs,
        log=(
            f"准备从断点续训（点击任务 {original.id[:8]}…，权重目录 {checkpoint_owner_id[:8]}…，"
            f"进度 {progress}/{original.total}）"
            f"；目标轮数 {epochs}，batch={params.get('batch')}，workers={params.get('workers')}"
        ),
    )
    db.add(resume_task)
    db.flush()
    db.add(ProjectExecutionLease(project_id=project_id, task_id=resume_task.id))
    linked_import = (
        db.query(PublicDatasetImport)
        .filter(PublicDatasetImport.train_task_id == original.id)
        .first()
    )
    if linked_import:
        linked_import.train_task_id = resume_task.id
        linked_import.state = "training"
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "该项目已有任务占用执行租约") from None
    db.refresh(resume_task)
    TaskWorker.start(resume_task.id)
    record_audit(
        db,
        actor=actor,
        action="task.resume",
        resource_type="task",
        resource_id=resume_task.id,
        project_id=project_id,
        summary="从断点继续训练",
        metadata={
            "resume_from_task_id": checkpoint_owner_id,
            "clicked_task_id": original.id,
            "checkpoint": str(checkpoint),
            "progress": original.progress,
            "total": epochs,
            "overrides": {k: overrides[k] for k in overrides if k in _RESUME_OVERRIDE_KEYS},
        },
    )
    return _task_out(resume_task)
