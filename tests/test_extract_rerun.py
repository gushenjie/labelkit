from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from server.db.models import Base, Frame, FrameStatus, Project, Task, TaskType, Video
from server.worker.task_worker import TaskWorker


def _write_video(path: Path, frame_count: int = 30) -> None:
    writer = cv2.VideoWriter(
        str(path),
        cv2.VideoWriter_fourcc(*"MJPG"),
        25.0,
        (64, 64),
    )
    image = np.full((64, 64, 3), 120, dtype=np.uint8)
    for _ in range(frame_count):
        writer.write(image)
    writer.release()


def test_reextract_replaces_unlabeled_frames(tmp_path, monkeypatch):
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()

    project = Project(id="project", name="P")
    video_path = tmp_path / "sample.avi"
    _write_video(video_path)
    video = Video(
        id="video-1",
        project_id=project.id,
        filename="sample.avi",
        storage_key="video-key",
        filepath=str(video_path),
        frame_count=30,
        fps=25.0,
        duration_sec=1.2,
    )
    task = Task(id="task", project_id=project.id, task_type=TaskType.EXTRACT, params={"video_ids": [video.id]})
    session.add_all([project, video, task])
    session.commit()

    out_dir = tmp_path / "frames"
    out_dir.mkdir()
    first_paths = [out_dir / "video-key_000000.jpg", out_dir / "video-key_000001.jpg"]
    second_paths = [out_dir / "video-key_000000.jpg", out_dir / "video-key_000001.jpg", out_dir / "video-key_000002.jpg"]
    call_count = {"value": 0}

    def fake_extract_frames(_video_path, output_dir, **kwargs):
        call_count["value"] += 1
        paths = first_paths if call_count["value"] == 1 else second_paths
        for path in paths:
            assert cv2.imwrite(str(path), np.full((32, 32, 3), call_count["value"] * 40, dtype=np.uint8))
        return paths

    monkeypatch.setattr("server.worker.task_worker.extract_frames", fake_extract_frames)
    monkeypatch.setattr("server.worker.task_worker.frames_dir", lambda _project_id, _split: out_dir)
    monkeypatch.setattr(TaskWorker, "_delete_frame_artifacts", staticmethod(lambda _pid, frame: Path(frame.filepath).unlink(missing_ok=True)))
    monkeypatch.setattr(TaskWorker, "_run_dedup", staticmethod(lambda *_args, **_kwargs: (0, 0)))

    TaskWorker._handle_extract(session, task)
    assert session.query(Frame).filter(Frame.video_id == video.id).count() == 2

    task2 = Task(id="task-2", project_id=project.id, task_type=TaskType.EXTRACT, params={"video_ids": [video.id], "auto_dedup": False})
    session.add(task2)
    session.commit()

    TaskWorker._handle_extract(session, task2)
    assert session.query(Frame).filter(Frame.video_id == video.id).count() == 3


def test_reextract_rejects_labeled_frames(tmp_path, monkeypatch):
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()

    project = Project(id="project", name="P")
    video_path = tmp_path / "sample.avi"
    _write_video(video_path)
    video = Video(
        id="video-1",
        project_id=project.id,
        filename="sample.avi",
        storage_key="video-key",
        filepath=str(video_path),
    )
    frame_path = tmp_path / "video-key_000000.jpg"
    assert cv2.imwrite(str(frame_path), np.zeros((16, 16, 3), dtype=np.uint8))
    existing = Frame(
        project_id=project.id,
        video_id=video.id,
        filename=frame_path.name,
        storage_key=frame_path.stem,
        filepath=str(frame_path),
        status=FrameStatus.HUMAN_OK,
    )
    task = Task(id="task", project_id=project.id, task_type=TaskType.EXTRACT, params={"video_ids": [video.id], "auto_dedup": False})
    session.add_all([project, video, existing, task])
    session.commit()

    out_dir = tmp_path / "frames"
    out_dir.mkdir()

    def fake_extract_frames(_video_path, output_dir, **kwargs):
        path = out_dir / "video-key_000000.jpg"
        assert cv2.imwrite(str(path), np.zeros((16, 16, 3), dtype=np.uint8))
        return [path]

    monkeypatch.setattr("server.worker.task_worker.extract_frames", fake_extract_frames)
    monkeypatch.setattr("server.worker.task_worker.frames_dir", lambda _project_id, _split: out_dir)
    monkeypatch.setattr(TaskWorker, "_delete_frame_artifacts", staticmethod(lambda _pid, frame: Path(frame.filepath).unlink(missing_ok=True)))

    with pytest.raises(RuntimeError, match="无法重复抽帧"):
        TaskWorker._handle_extract(session, task)
