from __future__ import annotations

import time
from datetime import datetime, timezone
from pathlib import Path

import anyio
import numpy as np
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from server.api import model_previews
from server.api.deps import get_current_user
from server.core.model_preview import PreviewRuntimeConfig, PreviewSessionManager
from server.db.database import get_db
from server.db.models import Base, ModelVersion, Project, ProjectTaskType, UserRole, UserStatus
from server.main import app
from server.services.user_service import UserDTO


class ApiFakeCapture:
    def __init__(self) -> None:
        self.released = False

    def isOpened(self) -> bool:
        return not self.released

    def read(self):
        if self.released:
            return False, None
        time.sleep(0.005)
        return True, np.zeros((32, 48, 3), dtype=np.uint8)

    def release(self) -> None:
        self.released = True

    def set(self, _prop_id: int, _value: float) -> bool:
        return True


class ApiFakeClasses:
    def tolist(self) -> list[float]:
        return []


class ApiFakeBoxes:
    cls = ApiFakeClasses()


class ApiFakeResult:
    boxes = ApiFakeBoxes()
    names: dict[int, str] = {}

    def __init__(self, frame: np.ndarray) -> None:
        self._frame = frame

    def plot(self) -> np.ndarray:
        return self._frame


class ApiFakeModel:
    task = "detect"
    names: dict[int, str] = {}

    def predict(self, *, source: np.ndarray, conf: float, verbose: bool):
        return [ApiFakeResult(source)]


def _user(user_id: str) -> UserDTO:
    return UserDTO(
        id=user_id,
        username=user_id,
        display_name=user_id,
        role=UserRole.ADMIN,
        status=UserStatus.ACTIVE,
        created_at=datetime.now(timezone.utc),
        last_login_at=None,
    )


def test_preview_api_create_query_capacity_and_stop(monkeypatch, tmp_path: Path):
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session_local = sessionmaker(bind=engine)
    session = session_local()
    model_path = tmp_path / "model.pt"
    model_path.write_bytes(b"model")
    project = Project(id="project-1", name="灭火器", task_type=ProjectTaskType.DETECT)
    model = ModelVersion(
        id="model-1",
        project_id=project.id,
        version=1,
        name="v1",
        filepath=str(model_path),
    )
    session.add_all([project, model])
    session.commit()

    manager = PreviewSessionManager(
        max_sessions=1,
        runtime=PreviewRuntimeConfig(idle_timeout_seconds=5),
        capture_factory=lambda _url: ApiFakeCapture(),
        model_factory=lambda _path: ApiFakeModel(),
        auto_reap=False,
    )
    monkeypatch.setattr(model_previews, "preview_manager", manager)
    current_user = [_user("user-1")]

    def override_db():
        yield session

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = lambda: current_user[0]
    client = TestClient(app)

    try:
        created = client.post(
            "/api/projects/project-1/models/model-1/preview-sessions",
            json={
                "rtspUrl": "rtsp://admin:secret@192.168.1.10/live",
                "confidenceThreshold": 0.3,
                "inferenceFps": 5,
            },
        )
        assert created.status_code == 201
        payload = created.json()
        assert payload["status"] == "STARTING"
        assert payload["streamPath"].endswith(f"/{payload['sessionId']}/stream")
        assert "secret" not in created.text
        session_id = payload["sessionId"]

        queried = client.get(
            f"/api/projects/project-1/models/model-1/preview-sessions/{session_id}"
        )
        assert queried.status_code == 200
        assert queried.json()["sessionId"] == session_id
        assert "rtsp" not in queried.text.lower()

        deadline = time.monotonic() + 2
        while manager.get(
            session_id=session_id,
            user_id="user-1",
            project_id="project-1",
            model_id="model-1",
        ).status.value != "STREAMING" and time.monotonic() < deadline:
            time.sleep(0.01)
        stream_response = model_previews.stream_preview_session(
            project_id="project-1",
            model_id="model-1",
            session_id=session_id,
            current_user=current_user[0],
        )

        async def read_first_stream_chunk() -> bytes:
            chunk = await anext(stream_response.body_iterator)
            close = getattr(stream_response.body_iterator, "aclose", None)
            if close is not None:
                await close()
            return chunk

        first_chunk = anyio.run(read_first_stream_chunk)
        assert stream_response.media_type == "multipart/x-mixed-replace; boundary=frame"
        assert first_chunk.startswith(b"--frame\r\nContent-Type: image/jpeg")

        duplicate = client.post(
            "/api/projects/project-1/models/model-1/preview-sessions",
            json={"rtspUrl": "rtsp://192.168.1.11/live"},
        )
        assert duplicate.status_code == 429
        assert duplicate.json()["detail"]["code"] == "PREVIEW_CAPACITY_EXCEEDED"

        current_user[0] = _user("user-2")
        forbidden = client.get(
            f"/api/projects/project-1/models/model-1/preview-sessions/{session_id}"
        )
        assert forbidden.status_code == 404

        current_user[0] = _user("user-1")
        stopped = client.delete(
            f"/api/projects/project-1/models/model-1/preview-sessions/{session_id}"
        )
        assert stopped.status_code == 200
        assert stopped.json()["status"] == "STOPPED"

        stopped_again = client.delete(
            f"/api/projects/project-1/models/model-1/preview-sessions/{session_id}"
        )
        assert stopped_again.status_code == 200
        assert stopped_again.json()["status"] == "STOPPED"
    finally:
        manager.close_all()
        app.dependency_overrides.clear()
        session.close()
        engine.dispose()


def test_preview_api_rejects_non_rtsp_url(monkeypatch, tmp_path: Path):
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    session_local = sessionmaker(bind=engine)
    session = session_local()
    model_path = tmp_path / "model.pt"
    model_path.write_bytes(b"model")
    project = Project(id="project-2", name="火焰", task_type=ProjectTaskType.DETECT)
    model = ModelVersion(
        id="model-2",
        project_id=project.id,
        version=1,
        name="v1",
        filepath=str(model_path),
    )
    session.add_all([project, model])
    session.commit()

    manager = PreviewSessionManager(
        max_sessions=1,
        runtime=PreviewRuntimeConfig(),
        capture_factory=lambda _url: ApiFakeCapture(),
        model_factory=lambda _path: ApiFakeModel(),
        auto_reap=False,
    )
    monkeypatch.setattr(model_previews, "preview_manager", manager)

    def override_db():
        yield session

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = lambda: _user("user-1")
    client = TestClient(app)
    try:
        response = client.post(
            "/api/projects/project-2/models/model-2/preview-sessions",
            json={"rtspUrl": "http://192.168.1.10/live"},
        )
        assert response.status_code == 422
        assert response.json()["detail"]["code"] == "INVALID_RTSP_URL"
    finally:
        manager.close_all()
        app.dependency_overrides.clear()
        session.close()
        engine.dispose()


def test_preview_api_requires_authentication():
    app.dependency_overrides.clear()
    client = TestClient(app)

    response = client.post(
        "/api/projects/project-1/models/model-1/preview-sessions",
        json={"rtspUrl": "rtsp://192.168.1.10/live"},
    )

    assert response.status_code == 401
