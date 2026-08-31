from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from server.api.projects import list_project_overviews
from server.api.tasks import list_all_tasks
from server.db.models import Base, Frame, FrameStatus, Project, Task, TaskType


def _session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)()


def test_dashboard_overview_aggregates_stats_and_latest_preview(monkeypatch, tmp_path):
    session = _session()
    project = Project(id="project", name="P")
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    session.add(project)
    session.add_all([
        Frame(
            id="older",
            project_id=project.id,
            filename="older.jpg",
            filepath="older.jpg",
            status=FrameStatus.UNLABELED,
            created_at=now,
        ),
        Frame(
            id="newer",
            project_id=project.id,
            filename="newer.jpg",
            filepath="newer.jpg",
            status=FrameStatus.NEEDS_HUMAN,
            created_at=now + timedelta(seconds=1),
        ),
    ])
    session.commit()
    monkeypatch.setattr("server.api.projects.project_dir", lambda _project_id: tmp_path)

    overview = list_project_overviews(session)[0]

    assert overview.project.frame_count == 2
    assert overview.stats == {"unlabeled": 1, "needs_human": 1, "total": 2}
    assert overview.preview_frame_id == "newer"
    assert overview.model_count == 0


def test_global_task_list_includes_project_name():
    session = _session()
    session.add(Project(id="project", name="P"))
    session.add(Task(id="task", project_id="project", task_type=TaskType.DEDUP))
    session.commit()

    rows = list_all_tasks(session)

    assert len(rows) == 1
    assert rows[0].id == "task"
    assert rows[0].project_name == "P"
