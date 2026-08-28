from __future__ import annotations

import os
import uuid
from pathlib import Path

import cv2
import numpy as np
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from server.config import settings
from server.core.train import run_train_task
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


pytestmark = [
    pytest.mark.model,
    pytest.mark.skipif(
        os.environ.get("LABELKIT_RUN_MODEL_SMOKE") != "1",
        reason="set LABELKIT_RUN_MODEL_SMOKE=1 to run real Ultralytics training",
    ),
]


def _write_image(path: Path, class_id: int, sample: int) -> None:
    image = np.zeros((96, 96, 3), dtype=np.uint8)
    color = (40 + class_id * 170, 60 + sample * 7, 220 - class_id * 150)
    if class_id == 0:
        cv2.rectangle(image, (18, 18), (76, 76), color, -1)
    else:
        cv2.circle(image, (48, 48), 29, color, -1)
    cv2.putText(image, str(sample), (4, 91), cv2.FONT_HERSHEY_SIMPLEX, 0.35, (255, 255, 255), 1)
    assert cv2.imwrite(str(path), image)


def _session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)()


def _seed_project(tmp_path: Path, task_type: ProjectTaskType):
    db = _session()
    project = Project(id=str(uuid.uuid4()), name=f"smoke-{task_type.value}", task_type=task_type)
    db.add(project)
    db.add_all([
        Category(project_id=project.id, class_id=0, name="square"),
        Category(project_id=project.id, class_id=1, name="circle"),
    ])
    media_dir = tmp_path / "source"
    media_dir.mkdir(parents=True)

    # Six independent source groups, each class represented in three groups.
    for index in range(12):
        class_id = index % 2
        group_id = f"class-{class_id}-group-{(index // 2) % 3}"
        image_path = media_dir / f"sample-{index}.jpg"
        _write_image(image_path, class_id, index)
        frame = Frame(
            id=str(uuid.uuid4()),
            project_id=project.id,
            filename=image_path.name,
            storage_key=uuid.uuid4().hex,
            source_group_id=group_id,
            filepath=str(image_path),
            status=FrameStatus.HUMAN_OK,
            source="training-smoke",
        )
        db.add(frame)
        db.flush()
        if task_type == ProjectTaskType.CLASSIFY:
            db.add(Annotation(frame_id=frame.id, class_id=class_id, source="manual"))
        else:
            db.add(Annotation(
                frame_id=frame.id,
                class_id=class_id,
                x_center=0.5,
                y_center=0.5,
                width=0.6,
                height=0.6,
                source="manual",
            ))
    task = Task(
        id=str(uuid.uuid4()),
        project_id=project.id,
        task_type=TaskType.TRAIN,
        params={
            "epochs": 1,
            "imgsz": 64,
            "batch": 2,
            "workers": 0,
            "device": "cpu",
            "base_model": "yolo11n-cls.pt" if task_type == ProjectTaskType.CLASSIFY else "yolo11n.pt",
        },
    )
    db.add(task)
    db.commit()
    return db, project, task


@pytest.mark.parametrize("task_type", [ProjectTaskType.DETECT, ProjectTaskType.CLASSIFY])
def test_real_training_produces_isolated_best_model(monkeypatch, tmp_path, task_type):
    monkeypatch.setattr(settings, "data_dir", tmp_path / "labelkit-data")
    db, project, task = _seed_project(tmp_path, task_type)

    run_train_task(db, task)

    model = db.query(ModelVersion).filter(ModelVersion.project_id == project.id).one()
    assert Path(model.filepath).is_file()
    assert model.dataset_version_id
    assert task.result["dataset_version_id"] == model.dataset_version_id
    assert task.result["output_dir"].endswith(f"task_{task.id}")
    assert Path(task.result["output_dir"], "weights", "best.pt").is_file()
    assert isinstance(task.result["metrics"], dict)
