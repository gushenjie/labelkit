from __future__ import annotations

from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from server.api import media
from server.db.models import Base, Frame, Project, Video
from server.worker.task_worker import TaskWorker


def test_delete_video_removes_files_frames_and_record(tmp_path, monkeypatch):
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    session.add(Project(id="project", name="P"))
    session.commit()

    video_path = tmp_path / "clip.mp4"
    thumb_path = tmp_path / "clip.cover.jpg"
    video_path.write_bytes(b"video")
    thumb_path.write_bytes(b"thumb")

    frame_path = tmp_path / "frame.jpg"
    frame_path.write_bytes(b"frame")

    video = Video(
        id="video-1",
        project_id="project",
        filename="clip.mp4",
        filepath=str(video_path),
        split="train",
    )
    frame = Frame(
        id="frame-1",
        project_id="project",
        video_id="video-1",
        filename="frame.jpg",
        filepath=str(frame_path),
        split="train",
    )
    session.add(video)
    session.add(frame)
    session.commit()

    monkeypatch.setattr(
        TaskWorker,
        "_delete_frame_artifacts",
        staticmethod(lambda _pid, item: Path(item.filepath).unlink(missing_ok=True)),
    )

    result = media.delete_video("project", "video-1", session)

    assert result == {"ok": True, "removed_frames": 1}
    assert session.get(Video, "video-1") is None
    assert session.query(Frame).count() == 0
    assert not video_path.exists()
    assert not thumb_path.exists()
    assert not frame_path.exists()


def test_delete_video_returns_404_for_missing(tmp_path):
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    session.add(Project(id="project", name="P"))
    session.commit()

    with pytest.raises(Exception) as exc:
        media.delete_video("project", "missing", session)
    assert "404" in str(exc.value)
