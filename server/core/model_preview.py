"""训练模型的 RTSP 实时预览会话。"""

from __future__ import annotations

import logging
import threading
import time
import uuid
from collections import Counter, deque
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import urlsplit

import cv2
import numpy as np

logger = logging.getLogger(__name__)


class PreviewStatus(str, Enum):
    """预览会话状态。"""

    STARTING = "STARTING"
    STREAMING = "STREAMING"
    RECONNECTING = "RECONNECTING"
    STOPPING = "STOPPING"
    STOPPED = "STOPPED"
    FAILED = "FAILED"


ACTIVE_PREVIEW_STATUSES = {
    PreviewStatus.STARTING,
    PreviewStatus.STREAMING,
    PreviewStatus.RECONNECTING,
    PreviewStatus.STOPPING,
}


class CaptureLike(Protocol):
    """OpenCV 视频读取器所需的最小协议。"""

    def isOpened(self) -> bool: ...

    def read(self) -> tuple[bool, np.ndarray | None]: ...

    def release(self) -> None: ...

    def set(self, prop_id: int, value: float) -> bool: ...


@dataclass(frozen=True)
class PreviewRuntimeConfig:
    """预览运行参数。"""

    connect_timeout_seconds: float = 10.0
    idle_timeout_seconds: float = 60.0
    jpeg_quality: int = 82
    max_frame_width: int = 1280
    reconnect_attempts: int = 5
    inference_error_limit: int = 3


@dataclass(frozen=True)
class PreviewSessionSnapshot:
    """供 API 使用的会话快照 DTO。"""

    session_id: str
    project_id: str
    model_id: str
    model_name: str
    status: PreviewStatus
    created_at: datetime
    frame_width: int | None
    frame_height: int | None
    inference_fps: float
    last_inference_ms: int | None
    detection_count: int
    class_counts: dict[str, int]
    last_frame_at: datetime | None
    error_code: str | None
    error_message: str | None


class PreviewCapacityError(RuntimeError):
    """预览容量达到上限。"""


class PreviewSessionNotFoundError(LookupError):
    """预览会话不存在或不属于当前用户。"""


def validate_rtsp_url(rtsp_url: str) -> str:
    """验证并返回去除首尾空白后的 RTSP 地址。"""

    normalized = rtsp_url.strip()
    try:
        parsed = urlsplit(normalized)
        port = parsed.port
    except ValueError as exc:
        raise ValueError("RTSP 地址格式无效") from exc
    if parsed.scheme.lower() not in {"rtsp", "rtsps"}:
        raise ValueError("仅支持 rtsp:// 或 rtsps:// 地址")
    if not parsed.hostname:
        raise ValueError("RTSP 地址缺少主机")
    if port is not None and not 1 <= port <= 65535:
        raise ValueError("RTSP 端口超出有效范围")
    return normalized


def redacted_rtsp_host(rtsp_url: str) -> str:
    """返回可安全写入日志的 RTSP 主机信息。"""

    try:
        parsed = urlsplit(rtsp_url)
        host = parsed.hostname or "未知主机"
        return f"{host}:{parsed.port}" if parsed.port is not None else host
    except ValueError:
        return "无效地址"


def open_rtsp_capture(rtsp_url: str, *, timeout_seconds: float) -> CaptureLike:
    """使用 OpenCV/FFmpeg 打开 RTSP，并尽量限制连接和读取阻塞时间。"""

    timeout_ms = max(1, int(timeout_seconds * 1000))
    params: list[int] = []
    if hasattr(cv2, "CAP_PROP_OPEN_TIMEOUT_MSEC"):
        params.extend([cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, timeout_ms])
    if hasattr(cv2, "CAP_PROP_READ_TIMEOUT_MSEC"):
        params.extend([cv2.CAP_PROP_READ_TIMEOUT_MSEC, timeout_ms])

    try:
        capture = cv2.VideoCapture(rtsp_url, cv2.CAP_FFMPEG, params)
    except (TypeError, cv2.error):
        capture = cv2.VideoCapture(rtsp_url, cv2.CAP_FFMPEG)
    try:
        capture.set(cv2.CAP_PROP_BUFFERSIZE, 1)
    except (AttributeError, cv2.error):
        pass
    return capture


def load_yolo_model(model_path: Path) -> Any:
    """延迟导入并加载 Ultralytics 模型。"""

    from ultralytics import YOLO

    return YOLO(str(model_path))


class PreviewSession:
    """单个模型与单路 RTSP 的实时预览会话。"""

    def __init__(
        self,
        *,
        user_id: str,
        project_id: str,
        model_id: str,
        model_name: str,
        model_path: Path,
        rtsp_url: str,
        confidence_threshold: float,
        target_inference_fps: float,
        runtime: PreviewRuntimeConfig,
        capture_factory: Callable[[str], CaptureLike],
        model_factory: Callable[[Path], Any],
    ) -> None:
        self.session_id = str(uuid.uuid4())
        self.user_id = user_id
        self.project_id = project_id
        self.model_id = model_id
        self.model_name = model_name
        self.model_path = model_path
        self._rtsp_url = validate_rtsp_url(rtsp_url)
        self.confidence_threshold = confidence_threshold
        self.target_inference_fps = target_inference_fps
        self.runtime = runtime
        self._capture_factory = capture_factory
        self._model_factory = model_factory

        self.created_at = datetime.now(timezone.utc)
        self._status = PreviewStatus.STARTING
        self._error_code: str | None = None
        self._error_message: str | None = None
        self._frame_width: int | None = None
        self._frame_height: int | None = None
        self._last_inference_ms: int | None = None
        self._detection_count = 0
        self._class_counts: dict[str, int] = {}
        self._last_frame_at: datetime | None = None
        self._inference_times: deque[float] = deque(maxlen=20)

        self._state_lock = threading.RLock()
        self._frame_condition = threading.Condition(threading.Lock())
        self._jpeg_condition = threading.Condition(threading.Lock())
        self._latest_frame: np.ndarray | None = None
        self._latest_frame_sequence = 0
        self._latest_jpeg: bytes | None = None
        self._latest_jpeg_sequence = 0
        self._stream_connected = False
        self._viewer_count = 0
        self._last_consumer_monotonic = time.monotonic()
        self._updated_monotonic = self._last_consumer_monotonic
        self._stop_event = threading.Event()
        self._capture_lock = threading.Lock()
        self._capture: CaptureLike | None = None
        self._capture_thread: threading.Thread | None = None
        self._inference_thread: threading.Thread | None = None

    @property
    def status(self) -> PreviewStatus:
        with self._state_lock:
            return self._status

    @property
    def is_active(self) -> bool:
        return self.status in ACTIVE_PREVIEW_STATUSES

    def start(self) -> None:
        """启动拉流与推理线程。"""

        with self._state_lock:
            if self._capture_thread is not None or self._inference_thread is not None:
                raise RuntimeError("预览会话已经启动")
            self._capture_thread = threading.Thread(
                target=self._capture_loop,
                name=f"preview-capture-{self.session_id[:8]}",
                daemon=True,
            )
            self._inference_thread = threading.Thread(
                target=self._inference_loop,
                name=f"preview-inference-{self.session_id[:8]}",
                daemon=True,
            )
            self._capture_thread.start()
            self._inference_thread.start()

    def snapshot(self) -> PreviewSessionSnapshot:
        """读取线程安全的会话快照。"""

        with self._state_lock:
            inference_fps = 0.0
            if len(self._inference_times) >= 2:
                duration = self._inference_times[-1] - self._inference_times[0]
                if duration > 0:
                    inference_fps = (len(self._inference_times) - 1) / duration
            return PreviewSessionSnapshot(
                session_id=self.session_id,
                project_id=self.project_id,
                model_id=self.model_id,
                model_name=self.model_name,
                status=self._status,
                created_at=self.created_at,
                frame_width=self._frame_width,
                frame_height=self._frame_height,
                inference_fps=round(inference_fps, 2),
                last_inference_ms=self._last_inference_ms,
                detection_count=self._detection_count,
                class_counts=dict(self._class_counts),
                last_frame_at=self._last_frame_at,
                error_code=self._error_code,
                error_message=self._error_message,
            )

    def iter_mjpeg(self) -> Iterator[bytes]:
        """持续输出当前会话最新的 MJPEG 帧。"""

        self._register_viewer()
        last_sequence = 0
        try:
            while True:
                with self._jpeg_condition:
                    self._jpeg_condition.wait_for(
                        lambda: self._latest_jpeg_sequence != last_sequence
                        or self.status in {PreviewStatus.FAILED, PreviewStatus.STOPPED},
                        timeout=0.5,
                    )
                    jpeg = self._latest_jpeg
                    sequence = self._latest_jpeg_sequence
                if sequence != last_sequence and jpeg is not None:
                    last_sequence = sequence
                    self._touch_consumer()
                    yield (
                        b"--frame\r\n"
                        b"Content-Type: image/jpeg\r\n"
                        + f"Content-Length: {len(jpeg)}\r\n\r\n".encode("ascii")
                        + jpeg
                        + b"\r\n"
                    )
                    continue
                if self.status in {PreviewStatus.FAILED, PreviewStatus.STOPPED}:
                    return
        finally:
            self._unregister_viewer()

    def should_stop_for_idle(self, now_monotonic: float) -> bool:
        """判断无人消费的活动会话是否已达到空闲上限。"""

        with self._state_lock:
            return (
                self._status in ACTIVE_PREVIEW_STATUSES
                and self._viewer_count == 0
                and now_monotonic - self._last_consumer_monotonic
                >= self.runtime.idle_timeout_seconds
            )

    def terminal_record_expired(self, now_monotonic: float, retention_seconds: float) -> bool:
        """判断终态会话是否可以从管理器移除。"""

        with self._state_lock:
            return (
                self._status in {PreviewStatus.STOPPED, PreviewStatus.FAILED}
                and now_monotonic - self._updated_monotonic >= retention_seconds
            )

    def stop(self) -> None:
        """幂等停止会话并释放拉流资源。"""

        with self._state_lock:
            if self._status == PreviewStatus.STOPPED:
                return
            failed = self._status == PreviewStatus.FAILED
            if not failed:
                self._set_status_locked(PreviewStatus.STOPPING)
        self._stop_event.set()
        self._notify_waiters()
        self._release_capture()

        current = threading.current_thread()
        for worker in (self._capture_thread, self._inference_thread):
            if worker is not None and worker is not current and worker.is_alive():
                worker.join(timeout=2.0)

        with self._state_lock:
            if not failed and self._status != PreviewStatus.FAILED:
                self._set_status_locked(PreviewStatus.STOPPED)
            self._rtsp_url = ""
        self._notify_waiters()

    def _capture_loop(self) -> None:
        first_attempt_at = time.monotonic()
        reconnect_count = 0
        ever_received_frame = False

        while not self._stop_event.is_set():
            if reconnect_count > 0:
                self._set_status(PreviewStatus.RECONNECTING)
            capture: CaptureLike | None = None
            try:
                capture = self._capture_factory(self._rtsp_url)
                with self._capture_lock:
                    self._capture = capture
                if not capture.isOpened():
                    reconnect_count += 1
                else:
                    while not self._stop_event.is_set():
                        readable, frame = capture.read()
                        if not readable or frame is None or frame.size == 0:
                            break
                        ever_received_frame = True
                        reconnect_count = 0
                        with self._state_lock:
                            self._stream_connected = True
                            self._updated_monotonic = time.monotonic()
                        with self._frame_condition:
                            self._latest_frame = frame
                            self._latest_frame_sequence += 1
                            self._frame_condition.notify_all()
                    if not self._stop_event.is_set():
                        reconnect_count += 1
            except Exception as exc:
                reconnect_count += 1
                if not self._stop_event.is_set():
                    logger.warning(
                        "RTSP 预览读取异常 | 会话ID: %s | 主机: %s | 异常类型: %s",
                        self.session_id,
                        redacted_rtsp_host(self._rtsp_url),
                        type(exc).__name__,
                    )
            finally:
                with self._state_lock:
                    self._stream_connected = False
                if capture is not None:
                    capture.release()
                with self._capture_lock:
                    if self._capture is capture:
                        self._capture = None

            if self._stop_event.is_set():
                return

            elapsed = time.monotonic() - first_attempt_at
            if reconnect_count > self.runtime.reconnect_attempts or (
                not ever_received_frame and elapsed >= self.runtime.connect_timeout_seconds
            ):
                code = "RTSP_STREAM_LOST" if ever_received_frame else "RTSP_CONNECT_TIMEOUT"
                message = "RTSP 视频流已中断，超过重连上限" if ever_received_frame else "无法在规定时间内读取 RTSP 视频帧"
                self._fail(code, message)
                return

            self._set_status(PreviewStatus.RECONNECTING)
            delay = min(0.5 * (2 ** max(0, reconnect_count - 1)), 4.0)
            self._stop_event.wait(delay)

    def _inference_loop(self) -> None:
        try:
            model = self._model_factory(self.model_path)
        except Exception as exc:
            self._fail("MODEL_LOAD_FAILED", "模型加载失败，请检查模型文件与运行环境", exc)
            return

        task = str(getattr(model, "task", "detect") or "detect").lower()
        if task != "detect":
            self._fail("UNSUPPORTED_MODEL_TASK", "实时预览仅支持目标检测模型")
            return

        last_frame_sequence = 0
        consecutive_errors = 0
        unlimited = self.target_inference_fps <= 0
        target_interval = 0.0 if unlimited else 1.0 / self.target_inference_fps

        while not self._stop_event.is_set():
            with self._frame_condition:
                self._frame_condition.wait_for(
                    lambda: self._latest_frame_sequence != last_frame_sequence
                    or self._stop_event.is_set(),
                    timeout=0.5,
                )
                if self._stop_event.is_set():
                    return
                if self._latest_frame_sequence == last_frame_sequence or self._latest_frame is None:
                    continue
                frame = self._latest_frame.copy()
                last_frame_sequence = self._latest_frame_sequence

            frame = self._resize_frame(frame)
            started_at = time.perf_counter()
            try:
                results = model.predict(
                    source=frame,
                    conf=self.confidence_threshold,
                    verbose=False,
                )
                result = results[0] if results else None
                annotated = result.plot() if result is not None else frame
                class_counts = self._class_counts_for_result(result, model)
                encoded, buffer = cv2.imencode(
                    ".jpg",
                    annotated,
                    [cv2.IMWRITE_JPEG_QUALITY, self.runtime.jpeg_quality],
                )
                if not encoded:
                    raise RuntimeError("JPEG 编码失败")
            except Exception as exc:
                consecutive_errors += 1
                logger.warning(
                    "模型预览推理异常 | 会话ID: %s | 模型ID: %s | 连续失败: %s | 异常类型: %s",
                    self.session_id,
                    self.model_id,
                    consecutive_errors,
                    type(exc).__name__,
                )
                if consecutive_errors >= self.runtime.inference_error_limit:
                    self._fail("INFERENCE_FAILED", "模型连续推理失败，预览已停止", exc)
                    return
                self._stop_event.wait(0.5 if unlimited else min(target_interval, 0.5))
                continue

            consecutive_errors = 0
            inference_seconds = time.perf_counter() - started_at
            now = datetime.now(timezone.utc)
            height, width = annotated.shape[:2]
            with self._state_lock:
                self._frame_width = int(width)
                self._frame_height = int(height)
                self._last_inference_ms = int(round(inference_seconds * 1000))
                self._detection_count = sum(class_counts.values())
                self._class_counts = class_counts
                self._last_frame_at = now
                self._inference_times.append(time.monotonic())
                self._updated_monotonic = time.monotonic()
                if self._stream_connected:
                    self._set_status_locked(PreviewStatus.STREAMING)
            with self._jpeg_condition:
                self._latest_jpeg = buffer.tobytes()
                self._latest_jpeg_sequence += 1
                self._jpeg_condition.notify_all()

            if not unlimited:
                remaining = target_interval - inference_seconds
                if remaining > 0:
                    self._stop_event.wait(remaining)

    def _resize_frame(self, frame: np.ndarray) -> np.ndarray:
        height, width = frame.shape[:2]
        if self.runtime.max_frame_width <= 0 or width <= self.runtime.max_frame_width:
            return frame
        scale = self.runtime.max_frame_width / float(width)
        resized_height = max(1, int(round(height * scale)))
        return cv2.resize(
            frame,
            (self.runtime.max_frame_width, resized_height),
            interpolation=cv2.INTER_AREA,
        )

    @staticmethod
    def _class_counts_for_result(result: Any, model: Any) -> dict[str, int]:
        if result is None or getattr(result, "boxes", None) is None:
            return {}
        classes = getattr(result.boxes, "cls", None)
        if classes is None:
            return {}
        values = classes.tolist() if hasattr(classes, "tolist") else list(classes)
        names = getattr(result, "names", None) or getattr(model, "names", {}) or {}
        labels: list[str] = []
        for value in values:
            class_id = int(value)
            if isinstance(names, dict):
                label = str(names.get(class_id, f"类别 {class_id}"))
            elif 0 <= class_id < len(names):
                label = str(names[class_id])
            else:
                label = f"类别 {class_id}"
            labels.append(label)
        return dict(Counter(labels))

    def _set_status(self, status: PreviewStatus) -> None:
        with self._state_lock:
            if self._status not in {PreviewStatus.FAILED, PreviewStatus.STOPPED}:
                self._set_status_locked(status)

    def _set_status_locked(self, status: PreviewStatus) -> None:
        self._status = status
        self._updated_monotonic = time.monotonic()

    def _fail(self, code: str, message: str, exc: Exception | None = None) -> None:
        with self._state_lock:
            if self._status in {PreviewStatus.FAILED, PreviewStatus.STOPPED}:
                return
            self._error_code = code
            self._error_message = message
            self._rtsp_url = ""
            self._set_status_locked(PreviewStatus.FAILED)
        self._stop_event.set()
        self._notify_waiters()
        self._release_capture()
        logger.error(
            "模型预览失败 | 会话ID: %s | 模型ID: %s | 错误码: %s | 异常类型: %s",
            self.session_id,
            self.model_id,
            code,
            type(exc).__name__ if exc is not None else "无",
        )

    def _release_capture(self) -> None:
        with self._capture_lock:
            capture = self._capture
        if capture is not None:
            capture.release()

    def _notify_waiters(self) -> None:
        with self._frame_condition:
            self._frame_condition.notify_all()
        with self._jpeg_condition:
            self._jpeg_condition.notify_all()

    def _register_viewer(self) -> None:
        with self._state_lock:
            self._viewer_count += 1
            self._last_consumer_monotonic = time.monotonic()

    def _touch_consumer(self) -> None:
        with self._state_lock:
            self._last_consumer_monotonic = time.monotonic()

    def _unregister_viewer(self) -> None:
        with self._state_lock:
            self._viewer_count = max(0, self._viewer_count - 1)
            self._last_consumer_monotonic = time.monotonic()


class PreviewSessionManager:
    """管理当前进程内的模型预览会话。"""

    def __init__(
        self,
        *,
        max_sessions: int,
        runtime: PreviewRuntimeConfig,
        capture_factory: Callable[[str], CaptureLike] | None = None,
        model_factory: Callable[[Path], Any] = load_yolo_model,
        reaper_interval_seconds: float = 1.0,
        auto_reap: bool = True,
    ) -> None:
        self.max_sessions = max(1, max_sessions)
        self.runtime = runtime
        self._capture_factory = capture_factory or (
            lambda url: open_rtsp_capture(
                url,
                timeout_seconds=self.runtime.connect_timeout_seconds,
            )
        )
        self._model_factory = model_factory
        self._sessions: dict[str, PreviewSession] = {}
        self._lock = threading.RLock()
        self._closed = threading.Event()
        self._reaper_interval_seconds = max(0.05, reaper_interval_seconds)
        self._reaper_thread: threading.Thread | None = None
        if auto_reap:
            self._reaper_thread = threading.Thread(
                target=self._reaper_loop,
                name="preview-session-reaper",
                daemon=True,
            )
            self._reaper_thread.start()

    def create(
        self,
        *,
        user_id: str,
        project_id: str,
        model_id: str,
        model_name: str,
        model_path: Path,
        rtsp_url: str,
        confidence_threshold: float,
        target_inference_fps: float,
    ) -> PreviewSession:
        """校验容量并创建预览会话。"""

        normalized_url = validate_rtsp_url(rtsp_url)
        with self._lock:
            self._prune_terminal_locked(time.monotonic())
            active_sessions = [session for session in self._sessions.values() if session.is_active]
            if any(session.user_id == user_id for session in active_sessions):
                raise PreviewCapacityError("当前用户已有活动预览，请先停止后再创建")
            if len(active_sessions) >= self.max_sessions:
                raise PreviewCapacityError("实时预览容量已满，请稍后重试")
            session = PreviewSession(
                user_id=user_id,
                project_id=project_id,
                model_id=model_id,
                model_name=model_name,
                model_path=model_path,
                rtsp_url=normalized_url,
                confidence_threshold=confidence_threshold,
                target_inference_fps=target_inference_fps,
                runtime=self.runtime,
                capture_factory=self._capture_factory,
                model_factory=self._model_factory,
            )
            self._sessions[session.session_id] = session
        session.start()
        logger.info(
            "模型预览已创建 | 会话ID: %s | 项目ID: %s | 模型ID: %s | 主机: %s",
            session.session_id,
            project_id,
            model_id,
            redacted_rtsp_host(normalized_url),
        )
        return session

    def get(
        self,
        *,
        session_id: str,
        user_id: str,
        project_id: str,
        model_id: str,
    ) -> PreviewSession:
        """获取属于当前上下文的预览会话。"""

        with self._lock:
            session = self._sessions.get(session_id)
        if (
            session is None
            or session.user_id != user_id
            or session.project_id != project_id
            or session.model_id != model_id
        ):
            raise PreviewSessionNotFoundError("预览会话不存在")
        return session

    def stop(
        self,
        *,
        session_id: str,
        user_id: str,
        project_id: str,
        model_id: str,
    ) -> PreviewSession:
        """停止属于当前用户的预览会话。"""

        session = self.get(
            session_id=session_id,
            user_id=user_id,
            project_id=project_id,
            model_id=model_id,
        )
        session.stop()
        logger.info(
            "模型预览已停止 | 会话ID: %s | 项目ID: %s | 模型ID: %s",
            session.session_id,
            project_id,
            model_id,
        )
        return session

    def reap_stale(self) -> None:
        """停止无人消费的会话，并清理过期终态记录。"""

        now = time.monotonic()
        with self._lock:
            idle_sessions = [
                session
                for session in self._sessions.values()
                if session.should_stop_for_idle(now)
            ]
        for session in idle_sessions:
            logger.info(
                "模型预览空闲超时 | 会话ID: %s | 模型ID: %s",
                session.session_id,
                session.model_id,
            )
            session.stop()
        with self._lock:
            self._prune_terminal_locked(now)

    def close_for_model(self, project_id: str, model_id: str) -> int:
        """停止指定模型上的全部预览会话。"""
        with self._lock:
            sessions = [
                session
                for session in self._sessions.values()
                if session.project_id == project_id and session.model_id == model_id
            ]
        for session in sessions:
            session.stop()
            logger.info(
                "删除模型前已停止预览 | 会话ID: %s | 模型ID: %s",
                session.session_id,
                model_id,
            )
        return len(sessions)

    def close_all(self) -> None:
        """停止管理器及全部会话。"""

        self._closed.set()
        with self._lock:
            sessions = list(self._sessions.values())
        for session in sessions:
            session.stop()
        worker = self._reaper_thread
        if worker is not None and worker is not threading.current_thread() and worker.is_alive():
            worker.join(timeout=2.0)

    def _reaper_loop(self) -> None:
        while not self._closed.wait(self._reaper_interval_seconds):
            self.reap_stale()

    def _prune_terminal_locked(self, now: float) -> None:
        retention = max(300.0, self.runtime.idle_timeout_seconds * 5)
        expired_ids = [
            session_id
            for session_id, session in self._sessions.items()
            if session.terminal_record_expired(now, retention)
        ]
        for session_id in expired_ids:
            self._sessions.pop(session_id, None)
