from __future__ import annotations

import asyncio
import zipfile
from io import BytesIO

import cv2
import numpy as np
from fastapi import UploadFile
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from server.api import media
from server.db.models import Base, Frame, MaterialBatch, MaterialOrigin, Project


def _png_upload(filename: str, value: int) -> UploadFile:
    image = np.full((20, 20, 3), value, dtype=np.uint8)
    ok, encoded = cv2.imencode(".png", image)
    assert ok
    return UploadFile(filename=filename, file=BytesIO(encoded.tobytes()))


def _zip_upload(filename: str, members: dict[str, int]) -> UploadFile:
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, value in members.items():
            image = np.full((20, 20, 3), value, dtype=np.uint8)
            ok, encoded = cv2.imencode(".png", image)
            assert ok
            archive.writestr(name, encoded.tobytes())
    buffer.seek(0)
    return UploadFile(filename=filename, file=buffer)


def test_upload_images_supports_multiple_files(tmp_path, monkeypatch):
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    session.add(Project(id="project", name="P"))
    session.commit()
    monkeypatch.setattr(media, "frames_dir", lambda _project_id, _split: tmp_path)

    result = asyncio.run(
        media.upload_images(
            "project",
            [_png_upload("a.png", 30), _png_upload("b.png", 220)],
            "train",
            session,
        )
    )

    frames = session.query(Frame).order_by(Frame.created_at).all()
    assert result["uploaded"] == 2
    assert result["material_batch_id"]
    assert len(frames) == 2
    batch = session.get(MaterialBatch, result["material_batch_id"])
    assert batch and batch.origin == MaterialOrigin.IMAGE_UPLOAD
    assert all(frame.material_batch_id == batch.id for frame in frames)
    assert all(__import__("pathlib").Path(frame.filepath).exists() for frame in frames)


def test_upload_images_supports_zip_archive(tmp_path, monkeypatch):
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    session.add(Project(id="project", name="P"))
    session.commit()
    monkeypatch.setattr(media, "frames_dir", lambda _project_id, _split: tmp_path)

    result = asyncio.run(
        media.upload_images(
            "project",
            [
                _zip_upload(
                    "dataset.zip",
                    {
                        "images/a.png": 30,
                        "images/b.png": 120,
                        "nested/c.jpg": 200,
                    },
                )
            ],
            "train",
            session,
        )
    )

    frames = session.query(Frame).order_by(Frame.filename).all()
    assert result["uploaded"] == 3
    assert result["material_batch_id"]
    assert [frame.filename for frame in frames] == ["images/a.png", "images/b.png", "nested/c.jpg"]
    assert all(__import__("pathlib").Path(frame.filepath).exists() for frame in frames)
