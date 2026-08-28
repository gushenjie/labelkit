from __future__ import annotations

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from server.api.projects import set_categories
from server.api.schemas import CategoryCreate
from server.db.models import Annotation, Base, Category, Frame, Project


def test_referenced_class_id_cannot_be_deleted_but_can_be_renamed():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    project = Project(id="project", name="P")
    category = Category(project_id=project.id, class_id=3, name="old")
    frame = Frame(project_id=project.id, filename="x.jpg", filepath="x.jpg")
    session.add_all([project, category, frame])
    session.flush()
    session.add(Annotation(frame_id=frame.id, class_id=3))
    session.commit()

    with pytest.raises(HTTPException) as error:
        set_categories(project.id, [], session)
    assert error.value.status_code == 409

    result = set_categories(project.id, [CategoryCreate(class_id=3, name="renamed")], session)
    assert result[0].class_id == 3
    assert result[0].name == "renamed"
