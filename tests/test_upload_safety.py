from __future__ import annotations

import asyncio
from io import BytesIO

import cv2
import numpy as np
from fastapi import UploadFile
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from server.api import media
from server.db.models import Base, Frame, Project


def _png_upload(filename: str, value: int) -> UploadFile:
    image = np.full((20, 20, 3), value, dtype=np.uint8)
    ok, encoded = cv2.imencode(".png", image)
    assert ok
    return UploadFile(filename=filename, file=BytesIO(encoded.tobytes()))


def test_same_name_uploads_use_different_physical_files(tmp_path, monkeypatch):
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    session.add(Project(id="project", name="P"))
    session.commit()
    monkeypatch.setattr(media, "frames_dir", lambda _project_id, _split: tmp_path)

    result = asyncio.run(
        media.upload_images(
            "project",
            [_png_upload("same.png", 30), _png_upload("same.png", 220)],
            "train",
            session,
        )
    )

    frames = session.query(Frame).order_by(Frame.created_at).all()
    assert result == {"uploaded": 2}
    assert [frame.filename for frame in frames] == ["same.png", "same.png"]
    assert frames[0].storage_key != frames[1].storage_key
    assert frames[0].filepath != frames[1].filepath
    assert all(__import__("pathlib").Path(frame.filepath).exists() for frame in frames)
