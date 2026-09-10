"""Fixed subprocess entry point for Ultralytics training."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class TrainingRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mode: Literal["detect", "classify"]
    base_model: str = Field(min_length=1)
    data: Path
    epochs: int = Field(ge=1, le=10_000)
    imgsz: int = Field(ge=32, le=8192)
    batch: int = Field(ge=1, le=4096)
    workers: int = Field(ge=0, le=64, default=0)
    device: str = "auto"
    output_root: Path
    run_name: str = Field(pattern=r"^task_[0-9a-f-]+$")
    metrics_path: Path
    resume: bool = False
    # 常用高级参数；None 表示交给 Ultralytics 默认值
    patience: int | None = Field(default=None, ge=0, le=10_000)
    lr0: float | None = Field(default=None, gt=0, le=1.0)
    optimizer: Literal["auto", "SGD", "Adam", "AdamW", "RMSProp"] | None = None
    seed: int | None = Field(default=None, ge=0, le=2_147_483_647)
    close_mosaic: int | None = Field(default=None, ge=0, le=10_000)
    weight_decay: float | None = Field(default=None, ge=0.0, le=1.0)
    warmup_epochs: float | None = Field(default=None, ge=0.0, le=100.0)


def _optional_train_kwargs(request: TrainingRequest) -> dict:
    kwargs: dict = {}
    for key in (
        "patience",
        "lr0",
        "optimizer",
        "seed",
        "close_mosaic",
        "weight_decay",
        "warmup_epochs",
    ):
        value = getattr(request, key)
        if value is not None:
            kwargs[key] = value
    return kwargs


def _resolve_device(requested: str) -> str:
    if requested != "auto":
        return requested
    import torch

    if torch.cuda.is_available():
        return "0"
    mps = getattr(torch.backends, "mps", None)
    if mps is not None and mps.is_available():
        return "mps"
    return "cpu"


def _normalize_workers(requested: int) -> int:
    """Windows 多进程 DataLoader 易复制数据集缓存导致 MemoryError，强制收紧。"""
    import sys

    value = max(0, int(requested))
    if sys.platform.startswith("win"):
        return min(value, 2)
    return min(value, 16)


def _json_safe(value):
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if hasattr(value, "item"):
        return value.item()
    return str(value)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--params", required=True, type=Path)
    args = parser.parse_args()
    request = TrainingRequest.model_validate_json(args.params.read_text(encoding="utf-8"))

    from ultralytics import YOLO

    device = _resolve_device(request.device)
    workers = _normalize_workers(request.workers)
    model = YOLO(request.base_model)
    train_kwargs = {
        "data": str(request.data),
        "epochs": request.epochs,
        "imgsz": request.imgsz,
        "batch": request.batch,
        "workers": workers,
        "device": device,
        "project": str(request.output_root),
        "name": request.run_name,
        "exist_ok": bool(request.resume),
        **_optional_train_kwargs(request),
    }
    if request.resume:
        # Ultralytics 会从 last.pt 恢复 epoch/优化器，并沿用原 save_dir
        train_kwargs["resume"] = True
        # 续训时关闭 dataset cache，降低内存峰值；workers 仍按请求（Windows 会再收紧）
        train_kwargs["cache"] = False
    results = model.train(**train_kwargs)
    metrics = _json_safe(getattr(results, "results_dict", {}))
    request.metrics_path.write_text(
        json.dumps({"device": device, "metrics": metrics}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
