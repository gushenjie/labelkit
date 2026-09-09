"""Model version API."""

from __future__ import annotations

import logging
import re
from hashlib import sha256
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import func
from sqlalchemy.orm import Session

from server.api.deps import get_optional_actor
from server.api.model_catalog_schemas import ModelCatalogOut
from server.api.schemas import (
    BaseModelCandidateOut,
    BuiltinWeightOut,
    ModelVersionOut,
    RegisterBuiltinModelsOut,
    RegisterBuiltinModelsRequest,
)
from server.core.audit import record_audit
from server.core.builtin_yolo import (
    builtin_models_cache_dir,
    list_builtin_weights,
    register_builtin_weights,
)
from server.core.model_catalog import TrainingModel, get_model_catalog
from server.core.paths import models_dir
from server.db.database import get_db
from server.db.models import DatasetVersion, Frame, ModelVersion, Project, Task

router = APIRouter(prefix="/api/projects/{project_id}/models", tags=["models"])
global_router = APIRouter(prefix="/api/models", tags=["models"])
logger = logging.getLogger(__name__)


def _model_source_label(model: ModelVersion) -> str:
    origin = (model.metrics or {}).get("origin")
    if origin == "upload":
        return "上传模型"
    if origin == "builtin":
        return "官方预训练"
    return "训练模型"


@global_router.get("/catalog", response_model=ModelCatalogOut)
def model_catalog(db: Session = Depends(get_db)):
    rows = (
        db.query(ModelVersion, Project, DatasetVersion, Task)
        .join(Project, Project.id == ModelVersion.project_id)
        .outerjoin(DatasetVersion, DatasetVersion.id == ModelVersion.dataset_version_id)
        .outerjoin(Task, Task.id == ModelVersion.task_id)
        .order_by(ModelVersion.created_at.desc())
        .all()
    )
    frame_ids_by_project: dict[str, list[str]] = {}
    project_ids = {project.id for _, project, _, _ in rows}
    if project_ids:
        for project_id, frame_id in (
            db.query(Frame.project_id, Frame.id)
            .filter(Frame.project_id.in_(project_ids))
            .order_by(Frame.project_id, Frame.id)
            .all()
        ):
            frame_ids_by_project.setdefault(project_id, []).append(frame_id)

    def preview_frame_id(model_id: str, project_id: str) -> str | None:
        """Pick a stable representative material frame for each trained model."""
        frame_ids = frame_ids_by_project.get(project_id, [])
        if not frame_ids:
            return None
        index = int.from_bytes(sha256(model_id.encode("utf-8")).digest()[:4], "big") % len(frame_ids)
        return frame_ids[index]

    def device_label(task: Task | None) -> str | None:
        device = task.result.get("device") if task else None
        if device is None:
            return None
        value = str(device).lower()
        if value in {"0", "cuda", "cuda:0"}:
            return "GPU"
        if value == "cpu":
            return "CPU"
        return str(device).upper()

    def duration_seconds(task: Task | None) -> int | None:
        if not task or not task.started_at or not task.finished_at:
            return None
        return max(0, int((task.finished_at - task.started_at).total_seconds()))

    trained_models = [
        TrainingModel(
            id=model.id,
            project_id=project.id,
            name=model.name,
            version=model.version,
            project_name=project.name,
            task_type=project.task_type.value,
            metrics=model.metrics,
            base_model=str(model.dataset_snapshot.get("base_model", "")),
            updated_at=model.created_at.strftime("%Y年%m月%d日"),
            source=_model_source_label(model),
            preview_frame_id=preview_frame_id(model.id, project.id),
            created_at=model.created_at,
            dataset_version=dataset_version.version if dataset_version else None,
            sample_count=model.dataset_snapshot.get("total"),
            class_count=len(dataset_version.categories) if dataset_version else None,
            device=device_label(task),
            duration_seconds=duration_seconds(task),
        )
        for model, project, dataset_version, task in rows
    ]
    return get_model_catalog(trained_models)


@global_router.get("/builtin", response_model=list[BuiltinWeightOut])
def list_builtin_models(task_type: str | None = Query(default=None)):
    cache = builtin_models_cache_dir()
    items = list_builtin_weights(task_type)
    return [
        BuiltinWeightOut(
            key=item.key,
            name=item.name,
            hint=item.hint,
            filename=item.filename,
            task=item.task,
            cached=(cache / item.filename).exists() and (cache / item.filename).stat().st_size > 1024,
        )
        for item in items
    ]


@global_router.get("/base-candidates", response_model=list[BaseModelCandidateOut])
def list_base_model_candidates(
    task_type: str | None = Query(default=None),
    db: Session = Depends(get_db),
):
    """工作区可选训练基座（真实 .pt），供训练页按本项目/其他项目分组。"""
    rows = (
        db.query(ModelVersion, Project)
        .join(Project, Project.id == ModelVersion.project_id)
        .order_by(ModelVersion.created_at.desc())
        .all()
    )
    out: list[BaseModelCandidateOut] = []
    for model, project in rows:
        project_task = project.task_type.value if hasattr(project.task_type, "value") else str(project.task_type)
        if task_type and project_task != task_type:
            continue
        path = Path(model.filepath)
        if not path.exists() or path.stat().st_size < 1_000_000:
            continue
        origin = str((model.metrics or {}).get("origin") or "train")
        out.append(
            BaseModelCandidateOut(
                id=model.id,
                project_id=project.id,
                project_name=project.name,
                version=model.version,
                name=model.name,
                filepath=str(path),
                task_type=project_task,
                origin=origin,
                created_at=model.created_at,
            )
        )
    return out


def _safe_name(name: str) -> str:
    base = Path(name).name
    return re.sub(r"[^\w.\-]", "_", base) or "model.pt"


@router.get("", response_model=list[ModelVersionOut])
def list_models(project_id: str, db: Session = Depends(get_db)):
    models = db.query(ModelVersion).filter(
        ModelVersion.project_id == project_id
    ).order_by(ModelVersion.version.desc()).all()
    return [ModelVersionOut.model_validate(m) for m in models]


@router.post("/upload", response_model=ModelVersionOut)
async def upload_model(
    project_id: str,
    file: UploadFile = File(...),
    name: str = Form(""),
    db: Session = Depends(get_db),
    actor: str = Depends(get_optional_actor),
):
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")

    filename = _safe_name(file.filename or "model.pt")
    if not filename.endswith(".pt"):
        raise HTTPException(400, "仅支持 .pt 模型文件")

    max_ver = db.query(func.max(ModelVersion.version)).filter(
        ModelVersion.project_id == project_id
    ).scalar() or 0

    dest_name = f"upload_v{max_ver + 1}_{filename}"
    dest = models_dir(project_id) / dest_name
    content = await file.read()
    if len(content) < 1024:
        raise HTTPException(400, "文件过小，不是有效的模型文件")
    dest.write_bytes(content)

    display_name = name.strip() or Path(filename).stem
    mv = ModelVersion(
        project_id=project_id,
        version=max_ver + 1,
        name=display_name,
        filepath=str(dest),
        metrics={"origin": "upload", "filename": filename},
        dataset_snapshot={},
        task_id=None,
    )
    db.add(mv)
    db.commit()
    db.refresh(mv)
    record_audit(
        db,
        actor=actor,
        action="model.upload",
        resource_type="model",
        resource_id=mv.id,
        project_id=project_id,
        summary=f"上传模型：{display_name}",
        metadata={"version": mv.version, "filename": filename},
    )
    return ModelVersionOut.model_validate(mv)


@router.post("/register-builtin", response_model=RegisterBuiltinModelsOut)
def register_builtin_models(
    project_id: str,
    body: RegisterBuiltinModelsRequest | None = None,
    db: Session = Depends(get_db),
    actor: str = Depends(get_optional_actor),
):
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    payload = body or RegisterBuiltinModelsRequest()
    try:
        result = register_builtin_weights(db, project, keys=payload.keys)
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    except RuntimeError as error:
        raise HTTPException(502, str(error)) from error

    created = [ModelVersionOut.model_validate(item) for item in result["created"]]
    if created:
        record_audit(
            db,
            actor=actor,
            action="model.register_builtin",
            resource_type="project",
            resource_id=project_id,
            project_id=project_id,
            summary=f"注册官方预训练 {len(created)} 个到模型中心",
            metadata={
                "created_keys": [item.metrics.get("builtin_key") for item in result["created"]],
                "downloaded": result["downloaded"],
                "skipped_keys": result["skipped_keys"],
            },
        )
    return RegisterBuiltinModelsOut(
        created=created,
        skipped_keys=result["skipped_keys"],
        downloaded=result["downloaded"],
        failed=result.get("failed") or [],
        task_type=result["task_type"],
    )


@router.post("/predict")
async def predict(
    project_id: str,
    model_id: str = Query(...),
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    mv = db.get(ModelVersion, model_id)
    if not mv or mv.project_id != project_id:
        raise HTTPException(404, "Model not found")

    from server.core.labeling import propose_yolo
    import tempfile

    suffix = Path(file.filename or "img.jpg").suffix
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(await file.read())
        tmp_path = Path(tmp.name)

    try:
        boxes = propose_yolo(Path(mv.filepath), tmp_path)
    except Exception as exc:
        logger.exception("Model trial inference failed for model_id=%s", model_id)
        raise HTTPException(503, "模型推理环境暂不可用，请检查 PyTorch 与模型运行依赖。") from exc
    finally:
        tmp_path.unlink(missing_ok=True)
    return {
        "boxes": [
            {"class_id": b.cls_id, "x": b.x, "y": b.y, "w": b.w, "h": b.h, "conf": b.conf}
            for b in boxes
        ]
    }
