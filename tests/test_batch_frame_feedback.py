from __future__ import annotations

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from server.api.frames import batch_frame_feedback
from server.api.schemas import BatchFrameFeedback
from server.db.models import Base, Frame, FrameStatus, Project


def test_batch_feedback_confirms_matching_statuses_and_clears_review_note():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    session.add(Project(id="project", name="P"))
    session.add_all(
        [
            Frame(
                id="a",
                project_id="project",
                filename="a.jpg",
                filepath="a.jpg",
                status=FrameStatus.NEEDS_HUMAN,
                review_note="误标提示",
            ),
            Frame(
                id="b",
                project_id="project",
                filename="b.jpg",
                filepath="b.jpg",
                status=FrameStatus.NEEDS_HUMAN,
                review_note="另一条",
            ),
            Frame(
                id="c",
                project_id="project",
                filename="c.jpg",
                filepath="c.jpg",
                status=FrameStatus.HUMAN_WRONG,
            ),
            Frame(
                id="d",
                project_id="project",
                filename="d.jpg",
                filepath="d.jpg",
                status=FrameStatus.HUMAN_OK,
            ),
        ]
    )
    session.commit()

    result = batch_frame_feedback(
        "project",
        BatchFrameFeedback(from_statuses=[FrameStatus.NEEDS_HUMAN], status=FrameStatus.HUMAN_OK),
        db=session,
        actor="tester",
    )
    assert result["ok"] is True
    assert result["updated"] == 2

    by_id = {frame.id: frame for frame in session.query(Frame).all()}
    assert by_id["a"].status == FrameStatus.HUMAN_OK
    assert by_id["a"].review_note == ""
    assert by_id["a"].source == "human"
    assert by_id["b"].status == FrameStatus.HUMAN_OK
    assert by_id["c"].status == FrameStatus.HUMAN_WRONG
    assert by_id["d"].status == FrameStatus.HUMAN_OK
