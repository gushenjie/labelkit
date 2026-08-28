from __future__ import annotations

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from server.api.frames import update_annotations
from server.api.schemas import AnnotationsUpdate
from server.db.models import Annotation, Base, Category, Frame, FrameStatus, Project


def test_invalid_annotation_save_preserves_existing_data(tmp_path, monkeypatch):
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    project = Project(id="project", name="P")
    frame = Frame(id="frame", project_id=project.id, filename="x.jpg", filepath=str(tmp_path / "x.jpg"))
    session.add_all([project, Category(project_id=project.id, class_id=0, name="target"), frame])
    session.flush()
    original = Annotation(
        frame_id=frame.id,
        class_id=0,
        x_center=0.5,
        y_center=0.5,
        width=0.25,
        height=0.25,
        source="manual",
    )
    session.add(original)
    frame.status = FrameStatus.HUMAN_OK
    session.commit()

    with pytest.raises(HTTPException, match="超出图片边界") as error:
        update_annotations(
            project.id,
            frame.id,
            AnnotationsUpdate(
                annotations=[
                    {
                        "class_id": 0,
                        "x_center": 0.95,
                        "y_center": 0.5,
                        "width": 0.2,
                        "height": 0.2,
                    }
                ],
                status=FrameStatus.HUMAN_WRONG,
            ),
            session,
        )

    assert error.value.status_code == 400
    session.expire_all()
    annotations = session.query(Annotation).filter(Annotation.frame_id == frame.id).all()
    assert len(annotations) == 1
    assert annotations[0].id == original.id
    assert session.get(Frame, frame.id).status == FrameStatus.HUMAN_OK


@pytest.mark.parametrize(
    ("annotation", "message"),
    [
        ({"class_id": 99, "x_center": 0.5, "y_center": 0.5, "width": 0.2, "height": 0.2}, "不存在的类别"),
        ({"class_id": 0, "x_center": 0.5, "width": 0.2, "height": 0.2}, "字段不完整"),
        ({"class_id": 0, "x_center": 0.5, "y_center": 0.5, "width": 0, "height": 0.2}, "宽高必须大于"),
        ({"class_id": 0, "x_center": 0.5, "y_center": 0.5, "width": 0.2, "height": 0.2, "confidence": "bad"}, "置信度不是有效数字"),
    ],
)
def test_invalid_detection_annotations_are_rejected(annotation, message):
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    project = Project(id="project", name="P")
    frame = Frame(id="frame", project_id=project.id, filename="x.jpg", filepath="x.jpg")
    session.add_all([project, Category(project_id=project.id, class_id=0, name="target"), frame])
    session.commit()

    with pytest.raises(HTTPException, match=message) as error:
        update_annotations(
            project.id,
            frame.id,
            AnnotationsUpdate(annotations=[annotation]),
            session,
        )
    assert error.value.status_code == 400
