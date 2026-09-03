from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from server.api.datasets import get_dataset_version_detail, list_dataset_catalog
from server.core import dataset_service as dataset_module
from server.core.dataset_service import (
    DatasetService,
    DatasetVersionRepository,
    reconcile_dataset_version_files,
    run_dataset_snapshot_task,
)
from server.db.models import (
    Annotation,
    Base,
    Category,
    Frame,
    FrameStatus,
    ModelVersion,
    Project,
    ProjectTaskType,
    Task,
    TaskType,
)


def _session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)()


def _seed(session, root: Path) -> Project:
    project = Project(id="project", name="Catalog project", task_type=ProjectTaskType.DETECT)
    session.add_all([project, Category(project_id=project.id, class_id=0, name="target")])
    for index in range(4):
        image_path = root / f"frame-{index}.jpg"
        assert cv2.imwrite(str(image_path), np.full((16, 24, 3), index * 30, dtype=np.uint8))
        frame = Frame(
            id=f"frame-{index}", project_id=project.id, filename=image_path.name,
            filepath=str(image_path), source_group_id=f"group-{index}", status=FrameStatus.HUMAN_OK,
        )
        session.add(frame)
        session.flush()
        session.add(Annotation(frame_id=frame.id, class_id=0, x_center=.5, y_center=.5, width=.2, height=.2))
    session.commit()
    return project


def test_catalog_is_compact_and_detail_contains_lineage(tmp_path, monkeypatch):
    session = _session()
    project = _seed(session, tmp_path)
    monkeypatch.setattr(dataset_module, "dataset_versions_dir", lambda _project_id: tmp_path / "versions")
    version = DatasetService(DatasetVersionRepository(session)).create_version(project.id, project.task_type)
    session.add(ModelVersion(
        id="model", project_id=project.id, version=1, name="v1", filepath="model.pt",
        dataset_version_id=version.id,
    ))
    session.add(Task(
        id="train", project_id=project.id, task_type=TaskType.TRAIN,
        result={"dataset_version_id": version.id},
    ))
    session.commit()

    catalog = list_dataset_catalog(offset=0, limit=100, db=session)
    item = catalog.items[0]
    assert catalog.total_versions == 1
    assert catalog.snapshot_sample_count == 4
    assert item.train_count + item.val_count == 4
    assert item.linked_model_count == 1
    assert "manifest" not in item.model_dump()

    detail = get_dataset_version_detail(project.id, version.id, session)
    assert detail.summary.id == version.id
    assert detail.linked_models[0].id == "model"
    assert detail.linked_tasks[0].id == "train"


def test_dataset_snapshot_task_returns_created_version(tmp_path, monkeypatch):
    session = _session()
    project = _seed(session, tmp_path)
    monkeypatch.setattr(dataset_module, "dataset_versions_dir", lambda _project_id: tmp_path / "versions")
    task = Task(id="snapshot", project_id=project.id, task_type=TaskType.DATASET_SNAPSHOT, params={"val_ratio": .25})
    session.add(task)
    session.commit()

    run_dataset_snapshot_task(session, task)

    assert task.result["dataset_version_id"]
    assert task.progress == task.total == 4


def test_reconcile_removes_only_unreferenced_snapshot_directories(tmp_path, monkeypatch):
    session = _session()
    project = _seed(session, tmp_path)
    versions_root = tmp_path / "versions"
    monkeypatch.setattr(dataset_module, "dataset_versions_dir", lambda _project_id: versions_root)
    DatasetService(DatasetVersionRepository(session)).create_version(project.id, project.task_type)
    session.commit()
    orphan = versions_root / ".orphan.staging"
    orphan.mkdir()

    assert reconcile_dataset_version_files(session) == 1
    assert not orphan.exists()
    assert len([path for path in versions_root.iterdir() if path.is_dir()]) == 1
