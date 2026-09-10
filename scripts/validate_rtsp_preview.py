"""用真实模型和 RTSP 视频源验证实时预览核心链路。"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

import psutil

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
if str(REPOSITORY_ROOT) not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT))

from server.core.model_preview import (
    PreviewRuntimeConfig,
    PreviewSessionManager,
    PreviewStatus,
    load_yolo_model,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="验证 LabelKit RTSP 实时模型预览")
    parser.add_argument("--model", required=True, type=Path, help="YOLO 目标检测模型路径")
    rtsp_source = parser.add_mutually_exclusive_group(required=True)
    rtsp_source.add_argument("--rtsp", help="后端可访问的 RTSP/RSTPS 地址")
    rtsp_source.add_argument(
        "--rtsp-env",
        metavar="ENV_NAME",
        help="从环境变量读取 RTSP 地址，避免凭据出现在进程参数中",
    )
    parser.add_argument("--seconds", type=float, default=10.0, help="采集时长，默认 10 秒")
    parser.add_argument("--confidence", type=float, default=0.25, help="置信度阈值")
    parser.add_argument("--fps", type=float, default=5.0, help="目标推理帧率")
    parser.add_argument("--max-width", type=int, default=1280, help="推理最大画面宽度")
    parser.add_argument("--output", type=Path, help="保存最后一张带框 JPEG")
    return parser.parse_args()


def read_process_metrics(process: psutil.Process) -> tuple[float, int] | None:
    """读取进程资源；Windows 查询偶发失败时不应中断预览验收。"""

    try:
        return process.memory_info().rss / 1024 / 1024, process.num_threads()
    except (MemoryError, OSError, psutil.Error):
        return None


def main() -> int:
    args = parse_args()
    model_path = args.model.resolve()
    if not model_path.is_file():
        raise SystemExit(f"模型文件不存在: {model_path}")
    if args.seconds <= 0:
        raise SystemExit("--seconds 必须大于 0")
    rtsp_url = args.rtsp
    if args.rtsp_env is not None:
        rtsp_url = os.environ.get(args.rtsp_env, "").strip()
        if not rtsp_url:
            raise SystemExit(f"环境变量 {args.rtsp_env} 未设置或为空")

    model_load_ms: float | None = None
    process = psutil.Process()
    initial_metrics = read_process_metrics(process)
    rss_start_mb, threads_start = initial_metrics or (0.0, 0)
    rss_peak_mb = rss_start_mb
    threads_peak = threads_start
    metric_sample_errors = 0

    def timed_model_factory(path: Path) -> Any:
        nonlocal model_load_ms
        started = time.perf_counter()
        model = load_yolo_model(path)
        model_load_ms = round((time.perf_counter() - started) * 1000, 1)
        return model

    manager = PreviewSessionManager(
        max_sessions=1,
        runtime=PreviewRuntimeConfig(
            connect_timeout_seconds=10,
            idle_timeout_seconds=max(30, args.seconds + 10),
            max_frame_width=args.max_width,
        ),
        model_factory=timed_model_factory,
        auto_reap=False,
    )
    started = time.perf_counter()
    session = manager.create(
        user_id="rtsp-validation",
        project_id="rtsp-validation",
        model_id=model_path.stem,
        model_name=model_path.name,
        model_path=model_path,
        rtsp_url=rtsp_url,
        confidence_threshold=args.confidence,
        target_inference_fps=args.fps,
    )
    stream = session.iter_mjpeg()
    first_frame_ms: float | None = None
    received_frames = 0
    last_jpeg: bytes | None = None
    deadline = time.monotonic() + args.seconds
    next_metric_sample_at = time.monotonic()

    try:
        while time.monotonic() < deadline:
            try:
                chunk = next(stream)
            except StopIteration:
                break
            if first_frame_ms is None:
                first_frame_ms = round((time.perf_counter() - started) * 1000, 1)
            received_frames += 1
            now = time.monotonic()
            if now >= next_metric_sample_at:
                metrics = read_process_metrics(process)
                if metrics is None:
                    metric_sample_errors += 1
                else:
                    rss_mb, thread_count = metrics
                    rss_peak_mb = max(rss_peak_mb, rss_mb)
                    threads_peak = max(threads_peak, thread_count)
                next_metric_sample_at = now + 1
            _, jpeg_with_suffix = chunk.split(b"\r\n\r\n", 1)
            last_jpeg = jpeg_with_suffix[:-2]
    finally:
        stream.close()
        snapshot = session.snapshot()
        manager.close_all()

    if args.output is not None and last_jpeg is not None:
        output_path = args.output.resolve()
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(last_jpeg)
    else:
        output_path = None
    final_metrics = read_process_metrics(process)
    rss_after_stop_mb, threads_after_stop = final_metrics or (None, None)

    report = {
        "status": snapshot.status.value,
        "modelLoadMs": model_load_ms,
        "firstAnnotatedFrameMs": first_frame_ms,
        "receivedFrames": received_frames,
        "elapsedSeconds": round(time.perf_counter() - started, 1),
        "inferenceFps": snapshot.inference_fps,
        "lastInferenceMs": snapshot.last_inference_ms,
        "frameSize": [snapshot.frame_width, snapshot.frame_height],
        "detectionCount": snapshot.detection_count,
        "classCounts": snapshot.class_counts,
        "errorCode": snapshot.error_code,
        "errorMessage": snapshot.error_message,
        "processRssMb": {
            "start": round(rss_start_mb, 1),
            "peak": round(rss_peak_mb, 1),
            "afterStop": round(rss_after_stop_mb, 1) if rss_after_stop_mb is not None else None,
        },
        "processThreads": {
            "start": threads_start,
            "peak": threads_peak,
            "afterStop": threads_after_stop,
        },
        "metricSampleErrors": metric_sample_errors,
        "output": str(output_path) if output_path is not None else None,
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if snapshot.status == PreviewStatus.STREAMING and received_frames > 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
