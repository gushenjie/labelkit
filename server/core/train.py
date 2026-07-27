"""YOLO training task."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path

import yaml
from sqlalchemy.orm import Session

from server.core.paths import exports_dir, frames_dir, labels_dir, models_dir
from server.db.models import Category, Frame, FrameStatus, ModelVersion, Project, ProjectTaskType, Task


TRAINABLE = {FrameStatus.AUTO_OK, FrameStatus.AUTO_FIXED, FrameStatus.HUMAN_OK, FrameStatus.NO_TARGET}


def assign_splits_by_ratio(frames: list[Frame], val_ratio: float = 0.2) -> dict[str, str]:
    """按图片数量比例划分 train/val（确定性，可复现）。"""
    ordered = sorted(frames, key=lambda f: f.id)
    n = len(ordered)
    if n == 0:
        return {}
    if n == 1:
        return {ordered[0].id: "train"}

    ratio = max(0.05, min(0.5, val_ratio))
    val_count = max(1, round(n * ratio))
    val_count = min(val_count, n - 1)

    # 均匀抽取验证集，避免全堆在 train 或 val 尾部
    step = n / val_count
    val_ids = {ordered[int(i * step)].id for i in range(val_count)}
    return {f.id: ("val" if f.id in val_ids else "train") for f in ordered}


def prepare_dataset(
    db: Session,
    project: Project,
    out_dir: Path,
    *,
    val_ratio: float = 0.2,
) -> dict:
    frames = db.query(Frame).filter(
        Frame.project_id == project.id,
        Frame.status.in_(TRAINABLE),
    ).all()
    split_map = assign_splits_by_ratio(frames, val_ratio)

    stats = {"train": 0, "val": 0, "total": 0}
    for frame in frames:
        split = split_map.get(frame.id, "train")
        img_src = Path(frame.filepath)
        if not img_src.exists():
            continue
        img_dst = out_dir / "images" / split / img_src.name
        lbl_dst = out_dir / "labels" / split / f"{img_src.stem}.txt"
        img_dst.parent.mkdir(parents=True, exist_ok=True)
        lbl_dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(img_src, img_dst)

        lbl_src = labels_dir(project.id, frame.split) / f"{img_src.stem}.txt"
        if lbl_src.exists():
            shutil.copy2(lbl_src, lbl_dst)
        else:
            lbl_dst.write_text("", encoding="utf-8")

        stats[split] += 1
        stats["total"] += 1

    categories = db.query(Category).filter(Category.project_id == project.id).order_by(Category.class_id).all()
    names = {c.class_id: c.name for c in categories}
    data_yaml = {
        "path": str(out_dir.resolve()),
        "train": "images/train",
        "val": "images/val",
        "names": names,
    }
    (out_dir / "dataset.yaml").write_text(yaml.dump(data_yaml, allow_unicode=True), encoding="utf-8")
    return stats


def prepare_classify_dataset(
    db: Session,
    project: Project,
    out_dir: Path,
    *,
    val_ratio: float = 0.2,
) -> dict:
    frames = db.query(Frame).filter(
        Frame.project_id == project.id,
        Frame.status.in_(TRAINABLE),
    ).all()
    split_map = assign_splits_by_ratio(frames, val_ratio)
    stats = {"train": 0, "val": 0, "total": 0}

    for frame in frames:
        split = split_map.get(frame.id, "train")
        if not frame.annotations:
            continue
        cls_id = frame.annotations[0].class_id
        cls_name = next((c.name for c in db.query(Category).filter(Category.project_id == project.id).all() if c.class_id == cls_id), str(cls_id))
        dst_dir = out_dir / split / cls_name
        dst_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(frame.filepath, dst_dir / Path(frame.filename).name)
        stats[split] += 1
        stats["total"] += 1

    return stats


def run_train_task(db: Session, task: Task, *, log: Callable[[str], None] | None = None) -> None:
    project = db.get(Project, task.project_id)
    params = task.params
    epochs = int(params.get("epochs", 80))
    imgsz = int(params.get("imgsz", 640))
    batch = int(params.get("batch", 8))
    device = params.get("device", "mps")
    base_model = params.get("base_model", "yolov8s.pt")
    val_ratio = float(params.get("val_ratio", 0.2))
    run_name = params.get("run_name", "labelkit_train")

    dataset_dir = exports_dir(project.id) / f"train_{task.id}"
    dataset_dir.mkdir(parents=True, exist_ok=True)

    if project.task_type == ProjectTaskType.CLASSIFY:
        stats = prepare_classify_dataset(db, project, dataset_dir, val_ratio=val_ratio)
        if stats["total"] < 10:
            raise RuntimeError(f"可训练样本过少: {stats['total']}")
        if log:
            log(f"分类数据集: {stats}")
        script = f"""
from ultralytics import YOLO
model = YOLO("{base_model}")
results = model.train(data="{dataset_dir}", epochs={epochs}, imgsz={imgsz}, batch={batch}, device="{device}", project="{exports_dir(project.id)}", name="{run_name}")
print("METRICS:", results.results_dict if hasattr(results, 'results_dict') else {{}})
"""
    else:
        stats = prepare_dataset(db, project, dataset_dir, val_ratio=val_ratio)
        if stats["total"] < 10:
            raise RuntimeError(f"可训练样本过少: {stats['total']}")
        if log:
            log(f"检测数据集: {stats}")
        data_yaml = dataset_dir / "dataset.yaml"
        script = f"""
from ultralytics import YOLO
model = YOLO("{base_model}")
results = model.train(data="{data_yaml}", epochs={epochs}, imgsz={imgsz}, batch={batch}, device="{device}", project="{exports_dir(project.id)}", name="{run_name}")
print("METRICS:", results.results_dict if hasattr(results, 'results_dict') else {{}})
"""

    task.total = epochs
    db.commit()
    if log:
        log("开始训练...")

    proc = subprocess.run(
        [sys.executable, "-c", script],
        capture_output=True,
        text=True,
        cwd=str(Path(__file__).resolve().parent.parent.parent),
    )
    output = proc.stdout + proc.stderr
    if log:
        log(output[-4000:])

    if proc.returncode != 0:
        raise RuntimeError(f"Training failed: {output[-1000:]}")

    run_dir = exports_dir(project.id) / run_name / "weights" / "best.pt"
    if not run_dir.exists():
        candidates = list((exports_dir(project.id) / run_name).rglob("best.pt"))
        if not candidates:
            raise RuntimeError("best.pt not found after training")
        run_dir = candidates[0]

    version = db.query(ModelVersion).filter(ModelVersion.project_id == project.id).count() + 1
    out_path = models_dir(project.id) / f"v{version}_best.pt"
    shutil.copy2(run_dir, out_path)

    metrics = {}
    for line in output.splitlines():
        if "METRICS:" in line:
            try:
                metrics = json.loads(line.split("METRICS:", 1)[1].strip().replace("'", '"'))
            except Exception:
                metrics = {"raw": line}

    mv = ModelVersion(
        project_id=project.id,
        version=version,
        name=f"v{version}",
        filepath=str(out_path),
        metrics=metrics,
        dataset_snapshot=stats,
        task_id=task.id,
    )
    db.add(mv)
    task.progress = epochs
    task.result = {"model_path": str(out_path), "version": version, "metrics": metrics, "dataset": stats}
    db.commit()
