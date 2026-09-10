"""训练断点续训辅助测试。"""

from __future__ import annotations

from pathlib import Path

from server.core.train_resume import (
    can_resume_train_task,
    find_resume_checkpoint,
    resolve_resume_checkpoint,
    training_run_dir,
)


def test_find_resume_checkpoint_requires_large_last_pt(tmp_path, monkeypatch):
    project_id = "p1"
    task_id = "11111111-1111-1111-1111-111111111111"

    def fake_exports(pid: str) -> Path:
        root = tmp_path / pid / "exports"
        root.mkdir(parents=True, exist_ok=True)
        return root

    monkeypatch.setattr("server.core.train_resume.exports_dir", fake_exports)
    weights = training_run_dir(project_id, task_id) / "weights"
    weights.mkdir(parents=True)
    last = weights / "last.pt"
    last.write_bytes(b"tiny")
    assert find_resume_checkpoint(project_id, task_id) is None

    last.write_bytes(b"x" * 1_000_001)
    found = find_resume_checkpoint(project_id, task_id)
    assert found == last
    assert can_resume_train_task(project_id, task_id, status="interrupted", task_type="train")
    assert can_resume_train_task(project_id, task_id, status="failed", task_type="train")
    assert not can_resume_train_task(project_id, task_id, status="completed", task_type="train")
    assert not can_resume_train_task(project_id, task_id, status="running", task_type="train")
    assert not can_resume_train_task(project_id, task_id, status="interrupted", task_type="export")


def test_resolve_resume_checkpoint_follows_resume_chain(tmp_path, monkeypatch):
    """续训任务本身没有 run 目录时，应落到源头任务的 last.pt。"""
    project_id = "p1"
    source_id = "11111111-1111-1111-1111-111111111111"
    resume_id = "22222222-2222-2222-2222-222222222222"

    def fake_exports(pid: str) -> Path:
        root = tmp_path / pid / "exports"
        root.mkdir(parents=True, exist_ok=True)
        return root

    monkeypatch.setattr("server.core.train_resume.exports_dir", fake_exports)
    weights = training_run_dir(project_id, source_id) / "weights"
    weights.mkdir(parents=True)
    last = weights / "last.pt"
    last.write_bytes(b"x" * 1_000_001)

    # 续训任务目录不存在
    assert find_resume_checkpoint(project_id, resume_id) is None
    resolved = resolve_resume_checkpoint(
        project_id,
        resume_id,
        params={"resume": True, "resume_from_task_id": source_id},
        retry_of_task_id=source_id,
    )
    assert resolved == (last, source_id)
    assert can_resume_train_task(
        project_id,
        resume_id,
        status="interrupted",
        task_type="train",
        params={"resume": True, "resume_from_task_id": source_id},
        retry_of_task_id=source_id,
    )


def test_training_request_accepts_resume_flag():
    from server.core.train_entry import TrainingRequest

    request = TrainingRequest(
        mode="detect",
        base_model=r"D:\runs\weights\last.pt",
        data=Path("data.yaml"),
        epochs=60,
        imgsz=640,
        batch=16,
        device="auto",
        output_root=Path("out"),
        run_name="task_01234567-89ab-cdef-0123-456789abcdef",
        metrics_path=Path("metrics.json"),
        resume=True,
    )
    assert request.resume is True


def test_train_resume_request_schema_accepts_params():
    from server.api.schemas import TrainResumeRequest

    body = TrainResumeRequest(params={"epochs": 80, "batch": 8, "workers": 0})
    assert body.params["epochs"] == 80
    assert body.params["batch"] == 8


def test_task_list_orders_by_last_activity_and_exposes_resume_lineage(tmp_path, monkeypatch):
    from datetime import datetime, timedelta, timezone

    from server.api.tasks import list_all_tasks
    from server.db.models import Base, Project, Task, TaskStatus, TaskType
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    db = Session()
    now = datetime.now(timezone.utc)
    db.add(Project(id="p1", name="鸟窝"))
    older = Task(
        id="11111111-1111-1111-1111-111111111111",
        project_id="p1",
        task_type=TaskType.TRAIN,
        status=TaskStatus.INTERRUPTED,
        progress=7,
        total=60,
        params={"epochs": 60},
        created_at=now - timedelta(hours=2),
        started_at=now - timedelta(hours=2),
        finished_at=now - timedelta(hours=1),
    )
    newer_resume = Task(
        id="22222222-2222-2222-2222-222222222222",
        project_id="p1",
        task_type=TaskType.TRAIN,
        status=TaskStatus.FAILED,
        progress=7,
        total=60,
        params={"resume": True, "resume_from_task_id": older.id, "epochs": 60},
        retry_of_task_id=older.id,
        created_at=now - timedelta(minutes=10),
        started_at=now - timedelta(minutes=10),
        finished_at=now - timedelta(minutes=5),
    )
    db.add_all([older, newer_resume])
    db.commit()

    rows = list_all_tasks(db)
    assert [row.id for row in rows[:2]] == [newer_resume.id, older.id]
    assert rows[0].resume_from_task_id == older.id
    assert rows[0].last_activity_at is not None
    assert rows[1].latest_resume_task_id == newer_resume.id
