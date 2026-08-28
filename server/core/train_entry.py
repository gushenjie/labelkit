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
    model = YOLO(request.base_model)
    results = model.train(
        data=str(request.data),
        epochs=request.epochs,
        imgsz=request.imgsz,
        batch=request.batch,
        workers=request.workers,
        device=device,
        project=str(request.output_root),
        name=request.run_name,
        exist_ok=False,
    )
    metrics = _json_safe(getattr(results, "results_dict", {}))
    request.metrics_path.write_text(
        json.dumps({"device": device, "metrics": metrics}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
