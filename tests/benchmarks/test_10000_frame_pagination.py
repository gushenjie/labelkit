from __future__ import annotations

import time
from datetime import datetime, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from server.api.frames import list_frames_page
from server.api.projects import list_project_overviews
from server.db.models import Base, Frame, FrameStatus, Project


@pytest.mark.benchmark
def test_10000_frame_cursor_pages_stay_interactive(monkeypatch, tmp_path):
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()
    db.add(Project(id="benchmark-project", name="10k benchmark"))
    created_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
    db.bulk_insert_mappings(
        Frame,
        [
            {
                "id": f"frame-{index:05d}",
                "project_id": "benchmark-project",
                "filename": f"frame-{index:05d}.jpg",
                "filepath": f"frame-{index:05d}.jpg",
                "status": FrameStatus.NEEDS_HUMAN,
                "uncertainty": (index % 1000) / 1000,
                "created_at": created_at,
                "updated_at": created_at,
            }
            for index in range(10_000)
        ],
    )
    db.commit()

    latencies: list[float] = []
    cursor = None
    seen: set[str] = set()
    for _ in range(5):
        started = time.perf_counter()
        page = list_frames_page(
            "benchmark-project",
            statuses="needs_human",
            split=None,
            sort="uncertainty",
            cursor=cursor,
            limit=100,
            db=db,
        )
        latencies.append(time.perf_counter() - started)
        assert len(page.items) == 100
        assert not (seen & {frame.id for frame in page.items})
        seen.update(frame.id for frame in page.items)
        cursor = page.next_cursor

    assert page.total == 10_000
    assert cursor is not None
    print(
        f"10k cursor benchmark: first={latencies[0] * 1000:.1f}ms, "
        f"max={max(latencies) * 1000:.1f}ms, page_size=100"
    )
    assert max(latencies) < 1.0, f"slowest cursor page took {max(latencies):.3f}s"

    monkeypatch.setattr("server.api.projects.project_dir", lambda _project_id: tmp_path)
    overview_started = time.perf_counter()
    overview = list_project_overviews(db)
    overview_latency = time.perf_counter() - overview_started
    assert overview[0].project.frame_count == 10_000
    assert overview[0].preview_frame_id is not None
    print(f"10k dashboard aggregate: {overview_latency * 1000:.1f}ms")
    assert overview_latency < 1.0, f"dashboard aggregate took {overview_latency:.3f}s"
