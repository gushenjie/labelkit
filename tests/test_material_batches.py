from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import cv2
import numpy as np
import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from server.api.materials import _batch_out
from server.api.schemas import TaskCreate
from server.core import dataset_service as dataset_module
from server.api.tasks import create_task
from server.core.dataset_service import DatasetService, DatasetVersionRepository
from server.db.models import (
    Annotation,
    Base,
    Category,
    DatasetVersionMaterialBatch,
    Frame,
    FrameStatus,
    MaterialBatch,
    MaterialOrigin,
    Project,
    ProjectTaskType,
    PublicDatasetImport,
    ProjectExecutionLease,
    TaskType,
)
from server.repositories.material_repository import MaterialRepository
from server.services.material_readiness_service import MaterialReadinessError, MaterialReadinessService


def _session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)()


def _write_image(path: Path, value: int) -> None:
    assert cv2.imwrite(str(path), np.full((24, 32, 3), value, dtype=np.uint8))


def test_readiness_blocks_when_another_public_batch_still_requires_review(tmp_path):
    db = _session()
    project = Project(id="project", name="P", task_type=ProjectTaskType.DETECT)
    ready_batch = MaterialBatch(project_id=project.id, origin=MaterialOrigin.IMAGE_UPLOAD, title="本地图片")
    review_batch = MaterialBatch(project_id=project.id, origin=MaterialOrigin.PUBLIC_DATASET, title="公开数据 B")
    db.add_all([project, ready_batch, review_batch])
    db.flush()
    image = tmp_path / "ready.jpg"
    _write_image(image, 80)
    db.add(
        Frame(
            project_id=project.id,
            material_batch_id=ready_batch.id,
            filename=image.name,
            filepath=str(image),
            source_group_id="local",
            status=FrameStatus.HUMAN_OK,
        )
    )
    db.add(
        PublicDatasetImport(
            project_id=project.id,
            material_batch_id=review_batch.id,
            provider="kaggle",
            source_ref="owner/data",
            title="公开数据 B",
            license_name="CC0",
            license_fingerprint="fingerprint",
            state="review",
            staging_path=str(tmp_path / "staging"),
        )
    )
    db.commit()

    with pytest.raises(MaterialReadinessError) as captured:
        MaterialReadinessService(MaterialRepository(db)).assert_current_pool_ready(project.id)

    assert [(item.batch_id, item.next_action) for item in captured.value.blockers] == [
        (review_batch.id, "review")
    ]

    with pytest.raises(HTTPException) as api_error:
        create_task(project.id, TaskCreate(task_type=TaskType.TRAIN, params={}), db, actor="tester")
    assert api_error.value.status_code == 409
    assert api_error.value.detail["blockers"][0]["batch_id"] == review_batch.id


def test_inventory_separates_unlabeled_work_from_public_review():
    db = _session()
    project = Project(id="project", name="P")
    local_batch = MaterialBatch(project_id=project.id, origin=MaterialOrigin.IMAGE_UPLOAD, title="本地图片")
    public_batch = MaterialBatch(project_id=project.id, origin=MaterialOrigin.PUBLIC_DATASET, title="公开数据")
    db.add_all([project, local_batch, public_batch])
    db.flush()
    db.add(Frame(project_id=project.id, material_batch_id=local_batch.id, filename="local.jpg", filepath="local.jpg"))
    review_ids = []
    for index in range(2):
        frame = Frame(
            project_id=project.id,
            material_batch_id=public_batch.id,
            filename=f"public-{index}.jpg",
            filepath=f"public-{index}.jpg",
            status=FrameStatus.HUMAN_OK,
        )
        db.add(frame)
        db.flush()
        review_ids.append(frame.id)
    db.add(
        PublicDatasetImport(
            project_id=project.id,
            material_batch_id=public_batch.id,
            provider="roboflow",
            source_ref="demo/data",
            license_fingerprint="fingerprint",
            state="review",
            review_frame_ids=review_ids,
        )
    )
    db.commit()

    inventory = MaterialRepository(db).inventory(project.id)
    local = next(item for item in inventory.items if item.id == local_batch.id)
    assert local.frame_status_counts == {"unlabeled": 1}
    assert _batch_out(local).frame_status_counts == {"unlabeled": 1}
    assert inventory.summary.intake_blocking_batch_count == 0
    assert inventory.summary.review_batch_count == 1
    assert inventory.summary.review_sample_count == 2
    assert inventory.summary.first_review_import_id is not None


def test_dataset_version_snapshots_mixed_batch_lineage(tmp_path, monkeypatch):
    db = _session()
    project = Project(id="project", name="P", task_type=ProjectTaskType.DETECT)
    db.add_all([project, Category(project_id=project.id, class_id=0, name="target")])
    batches = [
        MaterialBatch(project_id=project.id, origin=MaterialOrigin.IMAGE_UPLOAD, title="现场补充"),
        MaterialBatch(
            project_id=project.id,
            origin=MaterialOrigin.PUBLIC_DATASET,
            title="公开样本",
            metadata_json={"provider": "kaggle", "source_url": "https://example.invalid/dataset"},
        ),
    ]
    db.add_all(batches)
    db.flush()
    for index, batch in enumerate(batches):
        path = tmp_path / f"frame-{index}.jpg"
        _write_image(path, 40 + index * 120)
        frame = Frame(
            id=f"frame-{index}",
            project_id=project.id,
            material_batch_id=batch.id,
            filename=path.name,
            filepath=str(path),
            source_group_id=f"group-{index}",
            status=FrameStatus.HUMAN_OK,
        )
        db.add(frame)
        db.flush()
        db.add(
            Annotation(
                frame_id=frame.id,
                class_id=0,
                x_center=.5,
                y_center=.5,
                width=.2,
                height=.2,
            )
        )
    db.commit()
    monkeypatch.setattr(dataset_module, "dataset_versions_dir", lambda _project_id: tmp_path / "versions")

    version = DatasetService(DatasetVersionRepository(db)).create_version(project.id, project.task_type)
    db.commit()

    assert version.manifest["schema_version"] == 2
    assert {item["material_batch_id"] for item in version.manifest["frames"]} == {item.id for item in batches}
    assert {item["ingest_origin"] for item in version.manifest["frames"]} == {
        "image_upload",
        "public_dataset",
    }
    links = db.query(DatasetVersionMaterialBatch).filter_by(dataset_version_id=version.id).all()
    assert {item.material_batch_id for item in links} == {item.id for item in batches}
    assert all(item.frame_count == 1 and len(item.content_checksum) == 64 for item in links)


def test_archive_excludes_current_pool_but_keeps_version_lineage(tmp_path, monkeypatch):
    db = _session()
    project = Project(id="project", name="P", task_type=ProjectTaskType.DETECT)
    batch = MaterialBatch(project_id=project.id, origin=MaterialOrigin.IMAGE_UPLOAD, title="可归档批次")
    db.add_all([project, batch, Category(project_id=project.id, class_id=0, name="target")])
    db.flush()
    for index in range(2):
        path = tmp_path / f"archive-{index}.jpg"
        _write_image(path, index * 120)
        frame = Frame(
            project_id=project.id,
            material_batch_id=batch.id,
            filename=path.name,
            filepath=str(path),
            source_group_id=f"source-{index}",
            status=FrameStatus.HUMAN_OK,
        )
        db.add(frame)
        db.flush()
        db.add(Annotation(frame_id=frame.id, class_id=0, x_center=.5, y_center=.5, width=.2, height=.2))
    db.commit()
    monkeypatch.setattr(dataset_module, "dataset_versions_dir", lambda _project_id: tmp_path / "versions")
    version = DatasetService(DatasetVersionRepository(db)).create_version(project.id, project.task_type)
    db.commit()

    repository = MaterialRepository(db)
    repository.archive(project.id, batch.id)
    db.commit()

    assert repository.active_frames(project.id).count() == 0
    assert db.query(DatasetVersionMaterialBatch).filter_by(dataset_version_id=version.id).count() == 1
    assert (version.snapshot_path / "manifest.json").is_file()

    repository.restore(project.id, batch.id)
    db.commit()
    assert repository.active_frames(project.id).count() == 2


def test_archive_and_restore_share_project_execution_lease():
    db = _session()
    project = Project(id="project", name="P")
    batch = MaterialBatch(project_id=project.id, origin=MaterialOrigin.LEGACY, title="历史素材")
    db.add_all([project, batch])
    db.flush()
    db.add(ProjectExecutionLease(project_id=project.id, task_id="running-task"))
    db.commit()

    repository = MaterialRepository(db)
    with pytest.raises(RuntimeError, match="运行中任务"):
        repository.archive(project.id, batch.id)
    batch.archived_at = datetime.now(timezone.utc)
    db.commit()
    with pytest.raises(RuntimeError, match="运行中任务"):
        repository.restore(project.id, batch.id)
