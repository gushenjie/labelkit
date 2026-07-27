"""Model version API."""

from __future__ import annotations

import re
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import func
from sqlalchemy.orm import Session

from server.api.schemas import ModelVersionOut
from server.core.paths import models_dir
from server.db.database import get_db
from server.db.models import ModelVersion, Project

router = APIRouter(prefix="/api/projects/{project_id}/models", tags=["models"])


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

    boxes = propose_yolo(Path(mv.filepath), tmp_path)
    tmp_path.unlink(missing_ok=True)
    return {
        "boxes": [
            {"class_id": b.cls_id, "x": b.x, "y": b.y, "w": b.w, "h": b.h, "conf": b.conf}
            for b in boxes
        ]
    }
