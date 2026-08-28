"""Controlled public dataset discovery and import API."""

from __future__ import annotations

import shutil
import os

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from server.api.schemas import (
    PublicDatasetCandidateOut,
    PublicDatasetDiscoverOut,
    PublicDatasetDiscoverRequest,
    PublicDatasetFetchRequest,
    PublicDatasetImportOut,
    PublicDatasetPublishRequest,
    TaskOut,
)
from server.config import settings
from server.core.dataset_service import DatasetService, DatasetVersionRepository
from server.core.paths import public_imports_dir
from server.core.public_dataset_adapters import (
    discover_kaggle,
    discover_roboflow,
    expand_search_query,
    inspect_kaggle_ref,
    inspect_roboflow_url,
    license_fingerprint,
    provider_status,
    rank_public_candidates,
)
from server.core.public_dataset_types import PublicDatasetCandidateDTO, PublicImportDTO
from server.core.public_dataset_workflow import (
    evaluate_review,
    prepare_review_after_labeling,
    suggest_class_mapping,
)
from server.db.database import get_db
from server.db.models import ProjectExecutionLease, ProjectTaskType, Task, TaskType
from server.repositories.public_dataset_repository import PublicDatasetRepository
from server.worker.task_worker import TaskWorker


router = APIRouter(tags=["public-datasets"])


def _candidate_out(candidate: PublicDatasetCandidateDTO) -> PublicDatasetCandidateOut:
    payload = dict(candidate.__dict__)
    payload["classes"] = list(candidate.classes)
    return PublicDatasetCandidateOut(
        **payload,
        license_fingerprint=license_fingerprint(
            candidate.provider,
            candidate.source_ref,
            candidate.source_version,
            candidate.license_name,
            candidate.license_url,
        ),
    )


def _import_out(repository: PublicDatasetRepository, record: PublicImportDTO) -> PublicDatasetImportOut:
    context = repository.project_context(record.project_id)
    suggested = (
        record.workflow_metadata.get("suggested_mapping")
        or (suggest_class_mapping(record.source_classes, context.categories) if context else {})
    )
    image_count = int(record.quality_report.get("image_count") or 0)
    annotation_count = int(record.quality_report.get("annotation_count") or 0)
    return PublicDatasetImportOut(
        id=record.id,
        project_id=record.project_id,
        provider=record.provider,
        source_ref=record.source_ref,
        source_version=record.source_version,
        source_url=record.source_url,
        title=record.title,
        license_name=record.license_name,
        license_url=record.license_url,
        license_fingerprint=record.license_fingerprint,
        state=record.state,
        expected_download_bytes=record.expected_download_bytes,
        actual_download_bytes=record.actual_download_bytes,
        extracted_bytes=record.extracted_bytes,
        artifact_checksum=record.artifact_checksum,
        detected_format=record.detected_format,
        source_classes=list(record.source_classes),
        class_mapping=record.class_mapping,
        suggested_mapping=suggested,
        quality_report=record.quality_report,
        review_frame_ids=list(record.review_frame_ids),
        fetch_task_id=record.fetch_task_id,
        import_task_id=record.import_task_id,
        dataset_version_id=record.dataset_version_id,
        train_task_id=record.train_task_id,
        estimated_vlm_cost=(image_count * settings.vlm_cost_per_image if annotation_count == 0 else 0.0),
    )


def _enqueue(db: Session, project_id: str, task_type: TaskType, params: dict) -> Task:
    task = Task(project_id=project_id, task_type=task_type, params=params)
    db.add(task)
    db.flush()
    db.add(ProjectExecutionLease(project_id=project_id, task_id=task.id))
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "该项目已有任务占用执行租约") from None
    return task


@router.get("/api/public-datasets/providers")
def get_provider_status():
    return provider_status()


@router.post(
    "/api/projects/{project_id}/public-datasets/discover",
    response_model=PublicDatasetDiscoverOut,
)
def discover_public_datasets(
    project_id: str,
    body: PublicDatasetDiscoverRequest,
    db: Session = Depends(get_db),
):
    repository = PublicDatasetRepository(db)
    context = repository.project_context(project_id)
    if not context:
        raise HTTPException(404, "Project not found")
    candidates: list[PublicDatasetCandidateDTO] = []
    errors: dict[str, str] = {}
    category_names = [str(category["name"]) for category in context.categories]
    query = body.query.strip() or " ".join(category_names)
    if query:
        expanded = expand_search_query(query, category_names)
        try:
            candidates.extend(discover_kaggle(expanded))
        except RuntimeError as error:
            errors["kaggle"] = str(error)
        try:
            candidates.extend(
                discover_roboflow(expanded, task_type=context.task_type)
            )
        except RuntimeError as error:
            errors["roboflow"] = str(error)
    if body.roboflow_url.strip():
        try:
            candidates.append(inspect_roboflow_url(body.roboflow_url.strip()))
        except RuntimeError as error:
            errors["roboflow"] = str(error)
    if not query and not body.roboflow_url.strip():
        raise HTTPException(400, "请输入检索需求或 Roboflow Universe URL")
    ranking_query = query or " ".join(category_names)
    candidates = rank_public_candidates(
        candidates,
        query=ranking_query,
        category_names=category_names,
        task_type=context.task_type,
    )
    return PublicDatasetDiscoverOut(
        candidates=[_candidate_out(candidate) for candidate in candidates], errors=errors
    )


@router.post(
    "/api/projects/{project_id}/public-datasets/fetch",
    response_model=PublicDatasetImportOut,
)
def fetch_public_dataset(
    project_id: str,
    body: PublicDatasetFetchRequest,
    db: Session = Depends(get_db),
):
    repository = PublicDatasetRepository(db)
    context = repository.project_context(project_id)
    if not context:
        raise HTTPException(404, "Project not found")
    if not body.license_confirmed:
        raise HTTPException(400, "必须确认数据来源和许可证后才能下载")
    try:
        if body.provider == "kaggle":
            candidate = inspect_kaggle_ref(body.source_ref)
        elif body.provider == "roboflow":
            candidate = inspect_roboflow_url(body.source_url)
        else:
            raise RuntimeError(f"不支持的公开数据源: {body.provider}")
    except RuntimeError as error:
        raise HTTPException(400, str(error)) from error
    fresh_fingerprint = license_fingerprint(
        candidate.provider,
        candidate.source_ref,
        candidate.source_version,
        candidate.license_name,
        candidate.license_url,
    )
    if body.license_fingerprint != fresh_fingerprint:
        raise HTTPException(409, "数据集版本或许可证已变化，请重新检索并确认")
    if candidate.task_type and candidate.task_type != context.task_type:
        raise HTTPException(400, "公开数据集任务类型与项目不匹配")
    record = repository.create_import(
        project_id,
        candidate,
        imports_root=public_imports_dir(project_id),
        license_confirmed=True,
        task_type=context.task_type,
    )
    task = _enqueue(db, project_id, TaskType.PUBLIC_FETCH, {"import_id": record.id})
    record = repository.update(record.id, fetch_task_id=task.id)
    db.commit()
    TaskWorker.start(task.id)
    return _import_out(repository, record)


@router.get(
    "/api/projects/{project_id}/public-dataset-imports",
    response_model=list[PublicDatasetImportOut],
)
def list_public_dataset_imports(project_id: str, db: Session = Depends(get_db)):
    repository = PublicDatasetRepository(db)
    if not repository.project_context(project_id):
        raise HTTPException(404, "Project not found")
    return [_import_out(repository, record) for record in repository.list_for_project(project_id)]


@router.get(
    "/api/projects/{project_id}/public-dataset-imports/{import_id}",
    response_model=PublicDatasetImportOut,
)
def get_public_dataset_import(project_id: str, import_id: str, db: Session = Depends(get_db)):
    repository = PublicDatasetRepository(db)
    record = repository.get(project_id, import_id)
    if not record:
        raise HTTPException(404, "Public dataset import not found")
    return _import_out(repository, record)


@router.post(
    "/api/projects/{project_id}/public-dataset-imports/{import_id}/publish",
    response_model=TaskOut,
)
def publish_public_dataset(
    project_id: str,
    import_id: str,
    body: PublicDatasetPublishRequest,
    db: Session = Depends(get_db),
):
    repository = PublicDatasetRepository(db)
    record = repository.get(project_id, import_id)
    if not record:
        raise HTTPException(404, "Public dataset import not found")
    if record.state != "fetched":
        raise HTTPException(400, "公开数据尚未完成下载分析或已经发布")
    annotation_count = int(record.quality_report.get("annotation_count") or 0)
    if body.auto_label and annotation_count == 0:
        if not body.cost_confirmed:
            raise HTTPException(400, "必须确认 VLM 预估费用后才能自动标注")
        if not (settings.dashscope_api_key or os.environ.get("DASHSCOPE_API_KEY")):
            raise HTTPException(400, "自动标注需要先配置 DashScope API Key")
    metadata = {
        **record.workflow_metadata,
        "auto_label": body.auto_label,
        "cost_confirmed": body.cost_confirmed,
        "training_params": {
            "epochs": body.training_params.epochs,
            "imgsz": body.training_params.imgsz,
            "batch": body.training_params.batch,
            "device": body.training_params.device,
            "base_model": body.training_params.base_model,
        },
        "warnings_confirmed": body.warnings_confirmed,
    }
    repository.update(import_id, class_mapping=body.class_mapping, workflow_metadata=metadata)
    task = _enqueue(db, project_id, TaskType.PUBLIC_IMPORT, {"import_id": import_id})
    repository.update(import_id, import_task_id=task.id, state="publishing")
    db.commit()
    TaskWorker.start(task.id)
    db.refresh(task)
    return TaskOut.model_validate(task)


@router.post(
    "/api/projects/{project_id}/public-dataset-imports/{import_id}/approve-and-train",
    response_model=TaskOut,
)
def approve_public_dataset_and_train(
    project_id: str,
    import_id: str,
    db: Session = Depends(get_db),
):
    repository = PublicDatasetRepository(db)
    record = repository.get(project_id, import_id)
    if not record:
        raise HTTPException(404, "Public dataset import not found")
    if record.state == "needs_label":
        try:
            prepared = prepare_review_after_labeling(repository, import_id)
            db.commit()
        except RuntimeError as error:
            db.rollback()
            raise HTTPException(400, str(error)) from error
        raise HTTPException(409, f"已生成 {len(prepared.review_frame_ids)} 张风险复查样本，请完成复查后再次启动训练")
    try:
        outcome, affected = evaluate_review(repository, import_id)
    except RuntimeError as error:
        db.rollback()
        raise HTTPException(400, str(error)) from error
    if outcome == "expanded":
        db.commit()
        raise HTTPException(409, f"抽检发现修改，已扩大复查范围 {len(affected)} 张")
    if outcome == "full_review_required":
        db.commit()
        raise HTTPException(409, "抽检继续发现错误，必须全量复查或放弃数据集")

    context = repository.project_context(project_id)
    assert context is not None
    version = None
    try:
        task = _enqueue(db, project_id, TaskType.TRAIN, {})
        version = DatasetService(DatasetVersionRepository(db)).create_version(
            project_id,
            ProjectTaskType(context.task_type),
        )
        params = dict(record.workflow_metadata.get("training_params") or {})
        params["dataset_version_id"] = version.id
        task.params = params
        repository.update(
            import_id,
            state="training",
            dataset_version_id=version.id,
            train_task_id=task.id,
        )
    except Exception as error:
        db.rollback()
        if version and version.snapshot_path.exists():
            shutil.rmtree(version.snapshot_path)
        raise HTTPException(400, str(error)) from error
    db.commit()
    TaskWorker.start(task.id)
    db.refresh(task)
    return TaskOut.model_validate(task)


@router.post("/api/projects/{project_id}/public-dataset-imports/{import_id}/discard")
def discard_public_dataset(project_id: str, import_id: str, db: Session = Depends(get_db)):
    repository = PublicDatasetRepository(db)
    record = repository.get(project_id, import_id)
    if not record:
        raise HTTPException(404, "Public dataset import not found")
    if record.state in {"fetching", "publishing", "training"}:
        raise HTTPException(409, "任务运行期间不能放弃公开数据")
    try:
        removed = repository.discard(record)
        imports_root = public_imports_dir(project_id).resolve()
        root = record.staging_path.parent.resolve()
        if root == imports_root or imports_root not in root.parents:
            raise RuntimeError("公开数据暂存路径不在项目导入目录内")
        if root.exists():
            shutil.rmtree(root)
        db.commit()
    except RuntimeError as error:
        db.rollback()
        raise HTTPException(409, str(error)) from error
    return {"ok": True, "removed_frames": removed}
