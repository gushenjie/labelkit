from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from server.api.projects import get_project_dashboard, list_project_overviews
from server.api.tasks import list_all_tasks
from server.db.models import Base, Frame, FrameStatus, Project, Task, TaskType, UserRole
from server.services.user_service import UserService


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
    monkeypatch.setattr("server.api.projects.project_cover_service.has_cover", lambda _project_id: False)

    overview = list_project_overviews(session)[0]

    assert overview.project.frame_count == 2
    assert overview.stats == {"unlabeled": 1, "needs_human": 1, "total": 2}
    assert overview.preview_frame_id == "newer"
    assert overview.model_count == 0
    assert overview.task_count == 0
    assert overview.total_video_hours == 0


def test_dashboard_overview_can_skip_expensive_disk_scan(monkeypatch):
    session = _session()
    session.add(Project(id="project", name="P"))
    session.commit()

    def fail_if_scanned(_path):
        raise AssertionError("disk usage should not be scanned for the fast dashboard response")

    monkeypatch.setattr("server.api.projects._disk_usage_mb", fail_if_scanned)
    monkeypatch.setattr("server.api.projects.project_cover_service.has_cover", lambda _project_id: False)

    overview = list_project_overviews(session, include_disk_usage=False)[0]

    assert overview.project.disk_usage_mb == 0.0


def test_project_dashboard_returns_summary_and_project_rows(monkeypatch, tmp_path):
    session = _session()
    UserService(session).create_user(
        username="annotator",
        display_name="标注员甲",
        password="test-pass-123",
        role=UserRole.ANNOTATOR,
    )
    session.add(Project(id="project", name="Dashboard project"))
    session.add(Frame(
        id="frame",
        project_id="project",
        filename="frame.jpg",
        filepath="frame.jpg",
        status=FrameStatus.HUMAN_OK,
    ))
    session.add(Task(
        id="task",
        project_id="project",
        task_type=TaskType.LABEL,
        status="completed",
        finished_at=datetime.now(timezone.utc),
    ))
    session.commit()
    monkeypatch.setattr("server.api.projects.project_dir", lambda _project_id: tmp_path)
    monkeypatch.setattr("server.api.projects.project_cover_service.has_cover", lambda _project_id: False)

    dashboard = get_project_dashboard(session)

    assert dashboard.summary.total_projects == 1
    assert dashboard.summary.total_data_items == 1
    assert dashboard.summary.active_annotators == 1
    assert dashboard.summary.completed_tasks_last_30_days == 1
    assert dashboard.projects[0].task_count == 1
    assert dashboard.projects[0].completed_task_count == 1


def test_global_task_list_includes_project_name():
    session = _session()
    session.add(Project(id="project", name="P"))
    session.add(Task(id="task", project_id="project", task_type=TaskType.DEDUP))
    session.commit()

    rows = list_all_tasks(session)

    assert len(rows) == 1
    assert rows[0].id == "task"
    assert rows[0].project_name == "P"
    assert rows[0].assignee == "自动流水线"
    assert rows[0].priority == "low"
