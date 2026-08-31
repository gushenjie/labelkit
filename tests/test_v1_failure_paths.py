from __future__ import annotations

import asyncio
from io import BytesIO

import cv2
import numpy as np
import pytest
from fastapi import HTTPException, UploadFile
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from server.api.models import predict
from server.core import dataset_service as dataset_module
from server.core import train as train_module
from server.core.extract import extract_frames
from server.core.train import run_train_task
from server.core.train_entry import _resolve_device
from server.db.models import Annotation, Base, Category, Frame, FrameStatus, Project, Task, TaskType


def test_extract_rejects_unreadable_video(tmp_path):
    invalid_video = tmp_path / "broken.avi"
    invalid_video.write_bytes(b"not-a-video")

    with pytest.raises(RuntimeError, match="无法打开视频"):
        extract_frames(invalid_video, tmp_path / "frames")


def test_model_trial_rejects_unknown_model():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    session.add(Project(id="project", name="P"))
    session.commit()
    upload = UploadFile(filename="sample.png", file=BytesIO(b"image"))

    with pytest.raises(HTTPException, match="Model not found") as error:
        asyncio.run(predict("project", "missing-model", upload, session))
    assert error.value.status_code == 404


def test_training_rejects_too_few_samples_before_starting_subprocess(tmp_path, monkeypatch):
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    project = Project(id="project", name="P")
    task = Task(id="task", project_id=project.id, task_type=TaskType.TRAIN, params={"epochs": 1})
    session.add_all([project, Category(project_id=project.id, class_id=0, name="target"), task])
    for index in range(2):
        image_path = tmp_path / f"sample-{index}.png"
        assert cv2.imwrite(str(image_path), np.full((24, 24, 3), index * 100, dtype=np.uint8))
        frame = Frame(
            project_id=project.id,
            filename=image_path.name,
            filepath=str(image_path),
            source_group_id=f"group-{index}",
            status=FrameStatus.HUMAN_OK,
        )
        session.add(frame)
        session.flush()
        session.add(Annotation(frame_id=frame.id, class_id=0, x_center=0.5, y_center=0.5, width=0.5, height=0.5))
    session.commit()

    monkeypatch.setattr(dataset_module, "dataset_versions_dir", lambda _project_id: tmp_path / "versions")
    monkeypatch.setattr(train_module, "exports_dir", lambda _project_id: tmp_path / "exports")
    monkeypatch.setattr(train_module.subprocess, "Popen", lambda *_args, **_kwargs: pytest.fail("训练子进程不应启动"))

    with pytest.raises(RuntimeError, match="可训练样本过少: 2"):
        run_train_task(session, task)


def test_auto_device_falls_back_to_cpu_without_accelerator(monkeypatch):
    import torch

    monkeypatch.setattr(torch.cuda, "is_available", lambda: False)
    mps = getattr(torch.backends, "mps", None)
    if mps is not None:
        monkeypatch.setattr(mps, "is_available", lambda: False)

    assert _resolve_device("auto") == "cpu"
