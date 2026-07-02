"""Prepare dataset and run YOLO training from LabelKit confirmed frames."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import yaml

from labelkit.config import ProjectConfig
from labelkit.datasets import list_frames
from labelkit.store import FrameStatus, StateStore

TRAINABLE = {
    FrameStatus.AUTO_OK,
    FrameStatus.AUTO_FIXED,
    FrameStatus.HUMAN_OK,
}


def default_device() -> str:
    try:
        import torch

        if torch.backends.mps.is_available():
            return "mps"
        if torch.cuda.is_available():
            return "0"
    except Exception:
        pass
    return "cpu"


def count_trainable(config: ProjectConfig, store: StateStore) -> dict[str, int]:
    store.sync_frames()
    counts = {"train": 0, "val": 0, "total": 0}
    for frame in list_frames(config, store):
        if frame.status not in TRAINABLE:
            continue
        if not frame.image_path.exists() or not frame.label_path.exists():
            continue
        counts[frame.split] = counts.get(frame.split, 0) + 1
        counts["total"] += 1
    return counts


def prepare_dataset(
    config: ProjectConfig,
    store: StateStore,
    run_dir: Path,
) -> tuple[Path, dict]:
    """Copy auto_ok / human_ok / auto_fixed frames into run_dir dataset."""
    run_dir.mkdir(parents=True, exist_ok=True)
    ds_root = run_dir / "dataset"
    if ds_root.exists():
        shutil.rmtree(ds_root)
    manifest: list[dict] = []

    for frame in list_frames(config, store):
        if frame.status not in TRAINABLE:
            continue
        if not frame.image_path.exists() or not frame.label_path.exists():
            continue
        dst_img = ds_root / "images" / frame.split / f"{frame.stem}.jpg"
        dst_lbl = ds_root / "labels" / frame.split / f"{frame.stem}.txt"
        dst_img.parent.mkdir(parents=True, exist_ok=True)
        dst_lbl.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(frame.image_path, dst_img)
        shutil.copy2(frame.label_path, dst_lbl)
        manifest.append({"id": frame.id, "status": frame.status.value, "split": frame.split})

    names = {c.id: c.name for c in config.classes}
    ds_yaml = {
        "path": str(ds_root.resolve()),
        "train": "images/train",
        "val": "images/val",
        "names": names,
    }
    yaml_path = run_dir / "dataset.yaml"
    yaml_path.write_text(yaml.dump(ds_yaml, allow_unicode=True, default_flow_style=False), encoding="utf-8")
    (run_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    stats = {
        "total": len(manifest),
        "train": sum(1 for m in manifest if m["split"] == "train"),
        "val": sum(1 for m in manifest if m["split"] == "val"),
    }
    return yaml_path, stats


def run_training(
    *,
    data_yaml: Path,
    log_path: Path,
    epochs: int = 80,
    imgsz: int = 640,
    batch: int = 8,
    device: str | None = None,
    base_model: str = "yolov8s.pt",
    project: Path,
    name: str,
    out_model: Path,
) -> dict:
    """Run YOLO training synchronously; caller should run in subprocess."""
    from ultralytics import YOLO

    device = device or default_device()
    log_path.parent.mkdir(parents=True, exist_ok=True)

    def log(msg: str) -> None:
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(msg.rstrip() + "\n")

    log(f"device={device} epochs={epochs} batch={batch} imgsz={imgsz}")
    log(f"data={data_yaml}")
    log(f"base_model={base_model}")

    model = YOLO(base_model)
    results = model.train(
        data=str(data_yaml),
        epochs=epochs,
        imgsz=imgsz,
        batch=batch,
        device=device,
        project=str(project),
        name=name,
        exist_ok=True,
        patience=20,
        hsv_h=0.015,
        hsv_s=0.7,
        hsv_v=0.4,
        degrees=5.0,
        translate=0.1,
        scale=0.5,
        verbose=True,
    )

    best = project / name / "weights" / "best.pt"
    out_model.parent.mkdir(parents=True, exist_ok=True)
    if not best.exists():
        log(f"ERROR: best.pt not found at {best}")
        return {"ok": False, "error": "best.pt not found"}

    shutil.copy2(best, out_model)
    metrics = results.results_dict if hasattr(results, "results_dict") else {}
    map50 = float(metrics.get("metrics/mAP50(B)", 0) or 0)
    log(f"DONE: exported {out_model}")
    log(f"val mAP50 = {map50:.4f}")
    return {"ok": True, "map50": map50, "out_model": str(out_model)}
