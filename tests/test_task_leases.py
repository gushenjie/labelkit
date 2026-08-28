from __future__ import annotations

import subprocess
import sys
import time

import psutil
import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from server.api.schemas import TaskCreate
from server.api.tasks import create_task
from server.core.train import _terminate_process_tree
from server.db.models import (
    Base,
    Project,
    ProjectExecutionLease,
    Task,
    TaskStatus,
    TaskType,
)
from server.worker.task_worker import TaskWorker


def _session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    session.add(Project(id="project", name="P"))
    session.commit()
    return session


def test_database_lease_rejects_second_project_task(monkeypatch):
    session = _session()
    monkeypatch.setattr(TaskWorker, "start", classmethod(lambda _cls, _task_id: None))

    create_task("project", TaskCreate(task_type=TaskType.DEDUP), session)
    with pytest.raises(HTTPException) as error:
        create_task("project", TaskCreate(task_type=TaskType.EXPORT), session)

    assert error.value.status_code == 409
    assert session.query(ProjectExecutionLease).count() == 1
    assert session.query(Task).count() == 1


def test_restart_marks_unfinished_tasks_interrupted_and_releases_lease():
    session = _session()
    task = Task(
        id="task",
        project_id="project",
        task_type=TaskType.IMPORT,
        status=TaskStatus.RUNNING,
    )
    session.add_all([task, ProjectExecutionLease(project_id="project", task_id=task.id)])
    session.commit()

    assert TaskWorker.reconcile_stale_tasks(session) == 1

    assert task.status == TaskStatus.INTERRUPTED
    assert session.query(ProjectExecutionLease).count() == 0
    assert "手动重试" in task.log


def test_terminate_process_tree_removes_python_children():
    parent = subprocess.Popen(
        [
            sys.executable,
            "-c",
            (
                "import subprocess,sys,time; "
                "child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)']); "
                "print(child.pid, flush=True); time.sleep(60)"
            ),
        ],
        stdout=subprocess.PIPE,
        text=True,
    )
    assert parent.stdout is not None
    child_pid = int(parent.stdout.readline().strip())

    _terminate_process_tree(parent.pid, timeout=2.0)
    parent.wait(timeout=5)
    time.sleep(0.1)

    assert not psutil.pid_exists(parent.pid)
    assert not psutil.pid_exists(child_pid)
