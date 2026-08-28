from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from server.api.frames import list_frames_page
from server.db.models import Base, Frame, FrameStatus, Project


def test_cursor_pagination_is_stable_and_does_not_duplicate_rows():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    session.add(Project(id="project", name="P"))
    start = datetime(2026, 1, 1, tzinfo=timezone.utc)
    for index in range(205):
        session.add(
            Frame(
                id=f"frame-{index:04d}",
                project_id="project",
                filename=f"{index}.jpg",
                filepath=f"{index}.jpg",
                status=FrameStatus.NEEDS_HUMAN,
                uncertainty=float(index % 7) / 10,
                created_at=start + timedelta(seconds=index),
                updated_at=start + timedelta(seconds=index),
            )
        )
    session.commit()

    cursor = None
    seen: list[str] = []
    while True:
        page = list_frames_page(
            "project",
            statuses="needs_human",
            split=None,
            sort="uncertainty",
            cursor=cursor,
            limit=100,
            db=session,
        )
        seen.extend(frame.id for frame in page.items)
        cursor = page.next_cursor
        if not cursor:
            break

    assert page.total == 205
    assert len(seen) == 205
    assert len(set(seen)) == 205
