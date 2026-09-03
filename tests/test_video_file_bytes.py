from __future__ import annotations

from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from server.api.media import _build_video_out
from server.db.models import Base, Project, Video


def test_build_video_out_prefers_persisted_file_bytes(tmp_path):
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    session.add(Project(id="project", name="P"))
    video_path = tmp_path / "clip.mp4"
    video_path.write_bytes(b"1234567890")
    video = Video(
        id="video-1",
        project_id="project",
        filename="clip.mp4",
        filepath=str(video_path),
        file_bytes=42,
        split="train",
    )
    session.add(video)
    session.commit()

    result = _build_video_out(video)

    assert result.file_bytes == 42


def test_build_video_out_falls_back_to_file_stat(tmp_path):
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    session.add(Project(id="project", name="P"))
    video_path = tmp_path / "clip.mp4"
    video_path.write_bytes(b"1234567890")
    video = Video(
        id="video-1",
        project_id="project",
        filename="clip.mp4",
        filepath=str(video_path),
        split="train",
    )
    session.add(video)
    session.commit()

    result = _build_video_out(video)

    assert result.file_bytes == video_path.stat().st_size
