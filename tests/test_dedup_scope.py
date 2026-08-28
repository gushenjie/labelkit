from __future__ import annotations

import cv2
import numpy as np
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from server.db.models import Annotation, Base, Frame, FrameStatus, Project, Task, TaskType
from server.worker.task_worker import TaskWorker


def test_auto_dedup_only_deletes_new_unlabeled_frames(tmp_path, monkeypatch):
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    project = Project(id="project", name="P")
    session.add(project)

    image = np.full((32, 32, 3), 120, dtype=np.uint8)
    paths = [tmp_path / f"frame-{index}.jpg" for index in range(3)]
    for path in paths:
        assert cv2.imwrite(str(path), image)

    historical = Frame(
        id="historical",
        project_id=project.id,
        filename=paths[0].name,
        filepath=str(paths[0]),
        status=FrameStatus.HUMAN_OK,
    )
    new_a = Frame(
        id="new-a",
        project_id=project.id,
        filename=paths[1].name,
        filepath=str(paths[1]),
        status=FrameStatus.UNLABELED,
    )
    new_b = Frame(
        id="new-b",
        project_id=project.id,
        filename=paths[2].name,
        filepath=str(paths[2]),
        status=FrameStatus.UNLABELED,
    )
    task = Task(id="task", project_id=project.id, task_type=TaskType.EXTRACT)
    session.add_all([historical, new_a, new_b, task])
    session.commit()

    monkeypatch.setattr(TaskWorker, "_delete_frame_artifacts", staticmethod(lambda _pid, frame: __import__("pathlib").Path(frame.filepath).unlink(missing_ok=True)))
    kept, removed = TaskWorker._run_dedup(
        session,
        task,
        project.id,
        frame_ids=[new_a.id, new_b.id],
        threshold=8,
        apply=True,
    )

    assert (kept, removed) == (1, 1)
    assert session.get(Frame, historical.id) is not None
    assert paths[0].exists()
    assert session.query(Frame).filter(Frame.id.in_([new_a.id, new_b.id])).count() == 1


def test_standalone_dedup_is_dry_run_by_default(tmp_path, monkeypatch):
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    project = Project(id="project", name="P")
    task = Task(id="task", project_id=project.id, task_type=TaskType.DEDUP, params={})
    session.add_all([project, task])
    image = np.zeros((24, 24, 3), dtype=np.uint8)
    for index in range(2):
        path = tmp_path / f"duplicate-{index}.jpg"
        assert cv2.imwrite(str(path), image)
        session.add(Frame(project_id=project.id, filename=path.name, filepath=str(path)))
    session.commit()

    monkeypatch.setattr(TaskWorker, "_delete_frame_artifacts", staticmethod(lambda *_: pytest.fail("dry-run deleted a file")))
    TaskWorker._handle_dedup(session, task)

    assert task.result["dry_run"] is True
    assert task.result["would_remove"] == 1
    assert session.query(Frame).count() == 2
