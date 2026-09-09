from __future__ import annotations

from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from server.core import builtin_yolo
from server.core.builtin_yolo import BuiltinYoloWeight, register_builtin_weights
from server.db.models import Base, ModelVersion, Project, ProjectTaskType


def test_register_builtin_weights_copies_cache_and_is_idempotent(monkeypatch, tmp_path):
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    session.add(Project(id="project", name="鸟窝", task_type=ProjectTaskType.DETECT))
    session.commit()

    cache_dir = tmp_path / "builtin_models"
    project_models = tmp_path / "project_models"
    cache_dir.mkdir()
    project_models.mkdir()

    monkeypatch.setattr(builtin_yolo, "builtin_models_cache_dir", lambda: cache_dir)
    monkeypatch.setattr(builtin_yolo, "models_dir", lambda _project_id: project_models)

    def fake_ensure(weight: BuiltinYoloWeight, *, timeout: int = 300) -> Path:
        path = cache_dir / weight.filename
        if not path.exists():
            path.write_bytes(b"x" * 1_000_001)
        return path

    monkeypatch.setattr(builtin_yolo, "ensure_weight_cached", fake_ensure)

    project = session.get(Project, "project")
    first = register_builtin_weights(session, project, keys=["yolov8n", "yolov8s"])
    assert len(first["created"]) == 2
    assert sorted(Path(item.filepath).name for item in first["created"]) == [
        "builtin_yolov8n.pt",
        "builtin_yolov8s.pt",
    ]
    assert (project_models / "builtin_yolov8s.pt").exists()

    second = register_builtin_weights(session, project, keys=["yolov8n", "yolov8s"])
    assert second["created"] == []
    assert set(second["skipped_keys"]) == {"yolov8n", "yolov8s"}
    assert session.query(ModelVersion).count() == 2

    row = session.query(ModelVersion).filter(ModelVersion.name.like("%YOLOv8s%")).one()
    assert row.metrics["origin"] == "builtin"
    assert row.metrics["ultralytics_name"] == "yolov8s.pt"
