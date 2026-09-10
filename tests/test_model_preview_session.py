from __future__ import annotations

import time
from pathlib import Path

import numpy as np
import pytest

from server.core.model_preview import (
    PreviewCapacityError,
    PreviewRuntimeConfig,
    PreviewSessionManager,
    PreviewStatus,
    redacted_rtsp_host,
    validate_rtsp_url,
)


class FakeCapture:
    def __init__(self, *, fail_after: int | None = None) -> None:
        self.released = False
        self.read_count = 0
        self.fail_after = fail_after

    def isOpened(self) -> bool:
        return not self.released

    def read(self):
        if self.released:
            return False, None
        self.read_count += 1
        if self.fail_after is not None and self.read_count > self.fail_after:
            return False, None
        time.sleep(0.002)
        value = min(self.read_count, 255)
        return True, np.full((48, 64, 3), value, dtype=np.uint8)

    def release(self) -> None:
        self.released = True

    def set(self, _prop_id: int, _value: float) -> bool:
        return True


class FakeClasses:
    def tolist(self) -> list[float]:
        return [0.0, 0.0]


class FakeBoxes:
    cls = FakeClasses()


class FakeResult:
    boxes = FakeBoxes()
    names = {0: "灭火器"}

    def __init__(self, frame: np.ndarray) -> None:
        self._frame = frame

    def plot(self) -> np.ndarray:
        return self._frame


class FakeModel:
    task = "detect"
    names = {0: "灭火器"}

    def __init__(self, *, delay_seconds: float = 0.0) -> None:
        self.predict_count = 0
        self.delay_seconds = delay_seconds

    def predict(self, *, source: np.ndarray, conf: float, verbose: bool):
        assert 0.01 <= conf <= 1.0
        assert verbose is False
        if self.delay_seconds > 0:
            time.sleep(self.delay_seconds)
        self.predict_count += 1
        return [FakeResult(source)]


def _wait_for_status(session, status: PreviewStatus, timeout: float = 2.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if session.status == status:
            return
        time.sleep(0.01)
    raise AssertionError(f"会话未进入 {status.value}，当前状态为 {session.status.value}")


def test_preview_session_loads_model_once_and_streams_latest_frame(tmp_path: Path):
    capture = FakeCapture()
    model = FakeModel()
    model_loads: list[Path] = []
    manager = PreviewSessionManager(
        max_sessions=1,
        runtime=PreviewRuntimeConfig(idle_timeout_seconds=5, max_frame_width=64),
        capture_factory=lambda _url: capture,
        model_factory=lambda path: model_loads.append(path) or model,
        auto_reap=False,
    )
    model_path = tmp_path / "model.pt"
    model_path.write_bytes(b"model")

    session = manager.create(
        user_id="user-1",
        project_id="project-1",
        model_id="model-1",
        model_name="v1",
        model_path=model_path,
        rtsp_url="rtsp://admin:secret@192.168.1.10/live",
        confidence_threshold=0.25,
        target_inference_fps=10,
    )
    _wait_for_status(session, PreviewStatus.STREAMING)
    frame = next(session.iter_mjpeg())
    snapshot = session.snapshot()

    assert frame.startswith(b"--frame\r\nContent-Type: image/jpeg")
    assert model_loads == [model_path]
    assert model.predict_count >= 1
    assert snapshot.detection_count == 2
    assert snapshot.class_counts == {"灭火器": 2}
    assert snapshot.frame_width == 64
    assert snapshot.frame_height == 48

    manager.stop(
        session_id=session.session_id,
        user_id="user-1",
        project_id="project-1",
        model_id="model-1",
    )
    assert session.status == PreviewStatus.STOPPED
    assert capture.released is True
    manager.close_all()


def test_slow_model_drops_stale_frames_and_stops_without_draining_backlog(tmp_path: Path):
    capture = FakeCapture()
    model = FakeModel(delay_seconds=0.08)
    manager = PreviewSessionManager(
        max_sessions=1,
        runtime=PreviewRuntimeConfig(idle_timeout_seconds=5, max_frame_width=64),
        capture_factory=lambda _url: capture,
        model_factory=lambda _path: model,
        auto_reap=False,
    )
    model_path = tmp_path / "model.pt"
    model_path.write_bytes(b"model")
    session = manager.create(
        user_id="user-1",
        project_id="project-1",
        model_id="model-1",
        model_name="v1",
        model_path=model_path,
        rtsp_url="rtsp://192.168.1.10/live",
        confidence_threshold=0.25,
        target_inference_fps=10,
    )

    _wait_for_status(session, PreviewStatus.STREAMING)
    time.sleep(0.2)
    stop_started = time.monotonic()
    session.stop()

    assert model.predict_count >= 2
    assert capture.read_count > model.predict_count * 5
    assert time.monotonic() - stop_started < 1.0
    assert session.status == PreviewStatus.STOPPED
    assert capture.released is True
    manager.close_all()


def test_preview_manager_rejects_parallel_session_for_same_user(tmp_path: Path):
    captures: list[FakeCapture] = []

    def capture_factory(_url: str) -> FakeCapture:
        capture = FakeCapture()
        captures.append(capture)
        return capture

    manager = PreviewSessionManager(
        max_sessions=2,
        runtime=PreviewRuntimeConfig(idle_timeout_seconds=5),
        capture_factory=capture_factory,
        model_factory=lambda _path: FakeModel(),
        auto_reap=False,
    )
    model_path = tmp_path / "model.pt"
    model_path.write_bytes(b"model")
    first = manager.create(
        user_id="user-1",
        project_id="project-1",
        model_id="model-1",
        model_name="v1",
        model_path=model_path,
        rtsp_url="rtsp://192.168.1.10/live",
        confidence_threshold=0.25,
        target_inference_fps=5,
    )

    with pytest.raises(PreviewCapacityError, match="已有活动预览"):
        manager.create(
            user_id="user-1",
            project_id="project-1",
            model_id="model-1",
            model_name="v1",
            model_path=model_path,
            rtsp_url="rtsp://192.168.1.11/live",
            confidence_threshold=0.25,
            target_inference_fps=5,
        )

    first.stop()
    manager.close_all()


@pytest.mark.parametrize(
    "value",
    [
        "",
        "http://192.168.1.10/live",
        "rtsp:///missing-host",
        "rtsp://192.168.1.10:99999/live",
    ],
)
def test_validate_rtsp_url_rejects_invalid_inputs(value: str):
    with pytest.raises(ValueError):
        validate_rtsp_url(value)


def test_rtsp_log_identity_never_contains_credentials():
    identity = redacted_rtsp_host("rtsp://admin:secret@192.168.1.10:554/live")

    assert identity == "192.168.1.10:554"
    assert "admin" not in identity
    assert "secret" not in identity


def test_idle_session_is_stopped_and_releases_capture(tmp_path: Path):
    capture = FakeCapture()
    manager = PreviewSessionManager(
        max_sessions=1,
        runtime=PreviewRuntimeConfig(idle_timeout_seconds=0.01),
        capture_factory=lambda _url: capture,
        model_factory=lambda _path: FakeModel(),
        auto_reap=False,
    )
    model_path = tmp_path / "model.pt"
    model_path.write_bytes(b"model")
    session = manager.create(
        user_id="user-1",
        project_id="project-1",
        model_id="model-1",
        model_name="v1",
        model_path=model_path,
        rtsp_url="rtsp://192.168.1.10/live",
        confidence_threshold=0.25,
        target_inference_fps=5,
    )

    time.sleep(0.03)
    manager.reap_stale()

    assert session.status == PreviewStatus.STOPPED
    assert capture.released is True
    manager.close_all()


def test_failed_session_discards_rtsp_credentials(tmp_path: Path):
    def fail_model_load(_path: Path):
        raise RuntimeError("load failed")

    manager = PreviewSessionManager(
        max_sessions=1,
        runtime=PreviewRuntimeConfig(idle_timeout_seconds=5),
        capture_factory=lambda _url: FakeCapture(),
        model_factory=fail_model_load,
        auto_reap=False,
    )
    model_path = tmp_path / "model.pt"
    model_path.write_bytes(b"model")
    session = manager.create(
        user_id="user-1",
        project_id="project-1",
        model_id="model-1",
        model_name="v1",
        model_path=model_path,
        rtsp_url="rtsp://admin:secret@192.168.1.10/live",
        confidence_threshold=0.25,
        target_inference_fps=5,
    )

    _wait_for_status(session, PreviewStatus.FAILED)

    assert session.snapshot().error_code == "MODEL_LOAD_FAILED"
    assert session._rtsp_url == ""
    manager.close_all()


def test_preview_session_recovers_after_capture_reconnect(tmp_path: Path):
    captures = [FakeCapture(fail_after=1), FakeCapture()]
    created_captures: list[FakeCapture] = []

    def capture_factory(_url: str) -> FakeCapture:
        capture = captures[min(len(created_captures), len(captures) - 1)]
        created_captures.append(capture)
        return capture

    manager = PreviewSessionManager(
        max_sessions=1,
        runtime=PreviewRuntimeConfig(
            connect_timeout_seconds=3,
            idle_timeout_seconds=5,
            reconnect_attempts=3,
        ),
        capture_factory=capture_factory,
        model_factory=lambda _path: FakeModel(),
        auto_reap=False,
    )
    model_path = tmp_path / "model.pt"
    model_path.write_bytes(b"model")
    session = manager.create(
        user_id="user-1",
        project_id="project-1",
        model_id="model-1",
        model_name="v1",
        model_path=model_path,
        rtsp_url="rtsp://192.168.1.10/live",
        confidence_threshold=0.25,
        target_inference_fps=10,
    )

    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        if len(created_captures) >= 2 and session.status == PreviewStatus.STREAMING:
            break
        time.sleep(0.01)

    assert len(created_captures) >= 2
    assert created_captures[0].released is True
    assert session.status == PreviewStatus.STREAMING
    manager.close_all()


def test_preview_session_fails_after_reconnect_limit(tmp_path: Path):
    manager = PreviewSessionManager(
        max_sessions=1,
        runtime=PreviewRuntimeConfig(
            connect_timeout_seconds=5,
            idle_timeout_seconds=5,
            reconnect_attempts=1,
        ),
        capture_factory=lambda _url: FakeCapture(fail_after=0),
        model_factory=lambda _path: FakeModel(),
        auto_reap=False,
    )
    model_path = tmp_path / "model.pt"
    model_path.write_bytes(b"model")
    session = manager.create(
        user_id="user-1",
        project_id="project-1",
        model_id="model-1",
        model_name="v1",
        model_path=model_path,
        rtsp_url="rtsp://192.168.1.10/live",
        confidence_threshold=0.25,
        target_inference_fps=5,
    )

    _wait_for_status(session, PreviewStatus.FAILED, timeout=2)

    assert session.snapshot().error_code == "RTSP_CONNECT_TIMEOUT"
    manager.close_all()
