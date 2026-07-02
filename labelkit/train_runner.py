"""Background YOLO training job manager."""

from __future__ import annotations

import json
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path


@dataclass
class TrainJob:
    status: str = "idle"  # idle | running | done | failed
    log_path: str = ""
    run_dir: str = ""
    out_model: str = ""
    started_at: str = ""
    finished_at: str = ""
    error: str = ""
    stats: dict = field(default_factory=dict)
    result: dict = field(default_factory=dict)
    pid: int | None = None


class TrainRunner:
    _lock = threading.Lock()
    _job = TrainJob()
    _proc: subprocess.Popen | None = None

    @classmethod
    def snapshot(cls) -> dict:
        with cls._lock:
            return {
                "status": cls._job.status,
                "log_path": cls._job.log_path,
                "run_dir": cls._job.run_dir,
                "out_model": cls._job.out_model,
                "started_at": cls._job.started_at,
                "finished_at": cls._job.finished_at,
                "error": cls._job.error,
                "stats": cls._job.stats,
                "result": cls._job.result,
                "pid": cls._job.pid,
            }

    @classmethod
    def is_running(cls) -> bool:
        with cls._lock:
            return cls._job.status == "running"

    @classmethod
    def read_log(cls, offset: int = 0) -> tuple[str, int]:
        path = cls.snapshot().get("log_path")
        if not path or not Path(path).exists():
            return "", offset
        text = Path(path).read_text(encoding="utf-8", errors="replace")
        if offset > len(text):
            offset = len(text)
        return text[offset:], len(text)

    @classmethod
    def start(cls, *, config_path: str, params: dict) -> dict:
        with cls._lock:
            if cls._job.status == "running" and cls._proc and cls._proc.poll() is None:
                return {"ok": False, "error": "已有训练任务在运行"}

            run_id = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
            config_path = str(Path(config_path).resolve())
            cfg = Path(config_path)
            state_dir = Path(params["state_dir"])
            run_dir = state_dir / "train_runs" / run_id
            log_path = run_dir / "train.log"
            run_dir.mkdir(parents=True, exist_ok=True)

            cls._job = TrainJob(
                status="running",
                log_path=str(log_path),
                run_dir=str(run_dir),
                out_model=params.get("out_model", ""),
                started_at=datetime.now(timezone.utc).isoformat(),
                stats=params.get("dataset_stats", {}),
            )

            payload = {
                "config_path": config_path,
                "run_dir": str(run_dir),
                "log_path": str(log_path),
                "epochs": params.get("epochs", 80),
                "imgsz": params.get("imgsz", 640),
                "batch": params.get("batch", 8),
                "device": params.get("device", "mps"),
                "base_model": params.get("base_model", "yolov8s.pt"),
                "run_name": params.get("run_name", f"run_{run_id}"),
                "out_model": params.get("out_model", ""),
            }
            payload_path = run_dir / "job.json"
            payload_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

            cmd = [
                sys.executable,
                "-m",
                "labelkit.tasks.train_worker",
                str(payload_path),
            ]
            log_path.write_text("", encoding="utf-8")
            cls._proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
            )
            cls._job.pid = cls._proc.pid

            def _watch() -> None:
                assert cls._proc is not None
                with open(log_path, "a", encoding="utf-8") as log_f:
                    for line in cls._proc.stdout or []:
                        log_f.write(line)
                        log_f.flush()
                code = cls._proc.wait()
                result_path = run_dir / "result.json"
                with cls._lock:
                    cls._job.finished_at = datetime.now(timezone.utc).isoformat()
                    if result_path.exists():
                        cls._job.result = json.loads(result_path.read_text(encoding="utf-8"))
                    if code == 0 and cls._job.result.get("ok"):
                        cls._job.status = "done"
                    else:
                        cls._job.status = "failed"
                        cls._job.error = cls._job.result.get("error") or f"exit code {code}"
                cls._proc = None

            threading.Thread(target=_watch, daemon=True).start()
            return {"ok": True, "run_dir": str(run_dir), "log_path": str(log_path)}
