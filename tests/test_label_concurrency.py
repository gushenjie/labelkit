from __future__ import annotations

import threading
import time

import cv2
import numpy as np
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from server.config import settings
from server.core import label_runner
from server.core.labeling import ProposedBox
from server.db.models import Base, Category, Frame, Project, Task, TaskType


def test_vlm_calls_are_concurrent_but_database_writes_stay_in_main_thread(tmp_path, monkeypatch):
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    project = Project(id="project", name="P")
    task = Task(id="task", project_id=project.id, task_type=TaskType.LABEL)
    session.add_all([project, task, Category(project_id=project.id, class_id=0, name="target")])
    for index in range(6):
        image_path = tmp_path / f"{index}.jpg"
        assert cv2.imwrite(str(image_path), np.full((32, 32, 3), index * 20, dtype=np.uint8))
        session.add(Frame(project_id=project.id, filename=image_path.name, filepath=str(image_path)))
    session.commit()

    call_threads: set[int] = set()

    def fake_propose(*_args):
        call_threads.add(threading.get_ident())
        time.sleep(0.03)
        return [ProposedBox(2, 2, 12, 12, 0, 0.9, "vlm")], "ok"

    monkeypatch.setattr(settings, "vlm_max_concurrency", 3)
    monkeypatch.setattr(label_runner, "propose_detect", fake_propose)
    monkeypatch.setattr(label_runner, "label_path_for_frame", lambda _pid, frame: tmp_path / f"{frame.id}.txt")

    label_runner.run_label_task(session, task)

    assert len(call_threads) > 1
    assert task.result == {"ok": 6, "fail": 0, "stopped": False}
    assert sum(len(frame.annotations) for frame in session.query(Frame).all()) == 6
