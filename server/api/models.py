"""Model version API."""

from __future__ import annotations

import logging
import re
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import func
from sqlalchemy.orm import Session

from server.api.deps import get_optional_actor
from server.api.model_catalog_schemas import ModelCatalogOut
from server.api.schemas import ModelVersionOut
from server.core.audit import record_audit
from server.core.model_catalog import TrainingModel, get_model_catalog
from server.core.paths import models_dir
from server.db.database import get_db
from server.db.models import ModelVersion, Project

router = APIRouter(prefix="/api/projects/{project_id}/models", tags=["models"])
global_router = APIRouter(prefix="/api/models", tags=["models"])
logger = logging.getLogger(__name__)


@global_router.get("/catalog", response_model=ModelCatalogOut)
def model_catalog(db: Session = Depends(get_db)):
    rows = (
        db.query(ModelVersion, Project)
        .join(Project, Project.id == ModelVersion.project_id)
        .order_by(ModelVersion.created_at.desc())
        .all()
    )
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
            source="上传模型" if model.metrics.get("origin") == "upload" else "训练模型",
        )
        for model, project in rows
    ]
    return get_model_catalog(trained_models)


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
