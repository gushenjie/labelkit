"""YOLO training task."""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import threading
from collections import deque
from datetime import datetime, timezone
from queue import Empty, Queue
from collections.abc import Callable
from pathlib import Path

import yaml
from sqlalchemy.orm import Session

from server.core.dataset_service import DatasetService, DatasetVersionRepository
from server.core.paths import exports_dir, label_path_for_frame, models_dir
from server.core.train_process import (
    clear_train_pid,
    terminate_process_tree,
    write_train_pid,
)
from server.core.train_resume import (
    find_resume_checkpoint,
    training_dataset_dir,
    training_run_dir,
)
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

        lbl_src = label_path_for_frame(project.id, frame)
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


def _strip_ansi(text: str) -> str:
    """去掉 Ultralytics 训练输出里的 ANSI 控制符，便于解析 epoch 进度。"""
    return re.sub(r"\x1b\[[0-9;]*[a-zA-Z]|\[K", "", text)


def run_train_task(
    db: Session,
    task: Task,
    *,
    log: Callable[[str], None] | None = None,
    cancelled: Callable[[], bool] | None = None,
) -> None:
    project = db.get(Project, task.project_id)
    params = task.params
    epochs = int(params.get("epochs", 80))
    imgsz = int(params.get("imgsz", 640))
    batch = int(params.get("batch", 8))
    workers = int(params.get("workers", 0))
    device = params.get("device", "auto")
    requested_model = (params.get("base_model") or "").strip()
    val_ratio = float(params.get("val_ratio", 0.2))
    run_name = f"task_{task.id}"
    resume = bool(params.get("resume"))
    resume_from_task_id = str(params.get("resume_from_task_id") or "").strip()
    resume_source_task_id = resume_from_task_id or str(params.get("retry_of_task_id") or "").strip()
    resume_checkpoint: Path | None = None
    reused_dataset = False

    if resume:
        if not resume_source_task_id:
            raise RuntimeError("续训缺少来源任务 ID")
        resume_checkpoint = find_resume_checkpoint(project.id, resume_source_task_id)
        if resume_checkpoint is None:
            raise RuntimeError("未找到可续训权重 last.pt，请重新开始训练")
        requested_model = str(resume_checkpoint)
        if log:
            log(f"从断点续训 | 来源任务: {resume_source_task_id} | 权重: {resume_checkpoint}")

    def _optional_number(key: str, caster):
        if key not in params or params.get(key) is None or params.get(key) == "":
            return None
        return caster(params[key])

    advanced = {
        "patience": _optional_number("patience", int),
        "lr0": _optional_number("lr0", float),
        "seed": _optional_number("seed", int),
        "close_mosaic": _optional_number("close_mosaic", int),
        "weight_decay": _optional_number("weight_decay", float),
        "warmup_epochs": _optional_number("warmup_epochs", float),
    }
    optimizer = params.get("optimizer")
    if isinstance(optimizer, str) and optimizer.strip():
        advanced["optimizer"] = optimizer.strip()
    else:
        advanced["optimizer"] = None

    dataset_service = DatasetService(DatasetVersionRepository(db))
    requested_version_id = (params.get("dataset_version_id") or "").strip()
    source_dataset_dir = (
        training_dataset_dir(project.id, resume_source_task_id) if resume and resume_source_task_id else None
    )

    if resume and source_dataset_dir and source_dataset_dir.exists():
        dataset_dir = source_dataset_dir
        reused_dataset = True
        dataset_version = (
            dataset_service.get_version(project.id, requested_version_id)
            if requested_version_id
            else None
        )
        # 续训复用原导出目录，避免再次物化整份数据集
        if project.task_type == ProjectTaskType.CLASSIFY:
            data_path = dataset_dir
            train_n = len(list((dataset_dir / "train").glob("*"))) if (dataset_dir / "train").exists() else 0
            stats = {"train": train_n, "val": 0, "total": train_n}
        else:
            data_path = dataset_dir / "dataset.yaml"
            if not data_path.exists():
                raise RuntimeError(f"续训数据集配置不存在: {data_path}")
            # 粗略统计，仅用于结果快照
            train_n = len(list((dataset_dir / "images" / "train").glob("*"))) if (dataset_dir / "images" / "train").exists() else 0
            val_n = len(list((dataset_dir / "images" / "val").glob("*"))) if (dataset_dir / "images" / "val").exists() else 0
            stats = {"train": train_n, "val": val_n, "total": train_n + val_n}
        if log:
            log(f"复用原训练数据目录: {dataset_dir}")
    else:
        dataset_dir = exports_dir(project.id) / f"train_{task.id}"
        dataset_dir.mkdir(parents=True, exist_ok=True)
        dataset_version = (
            dataset_service.get_version(project.id, requested_version_id)
            if requested_version_id
            else dataset_service.create_version(project.id, project.task_type, val_ratio=val_ratio)
        )
        db.commit()
        try:
            stats = dataset_service.materialize(dataset_version, dataset_dir, cancelled=cancelled)
        except Exception:
            if dataset_dir.exists():
                shutil.rmtree(dataset_dir)
            raise

        if project.task_type == ProjectTaskType.CLASSIFY:
            data_path = dataset_dir
        else:
            data_path = dataset_dir / "dataset.yaml"

    if project.task_type == ProjectTaskType.CLASSIFY:
        base_model = requested_model or "yolov8s-cls.pt"
        if base_model == "yolov8s.pt":
            base_model = "yolov8s-cls.pt"
        if stats["total"] < 10:
            raise RuntimeError(f"可训练样本过少: {stats['total']}")
        if log and not resume:
            log(f"分类数据集: {stats}")
    else:
        base_model = requested_model or "yolov8s.pt"
        if stats["total"] < 5:
            raise RuntimeError(f"可训练样本过少: {stats['total']}（检测任务至少需要 5 张）")
        if log and not resume:
            log(f"检测数据集: {stats}")

    task.total = epochs
    if resume and task.progress <= 0:
        # 若续训任务未带上进度，尽量从来源任务进度展示
        pass
    db.commit()
    if log:
        log("继续训练..." if resume else "开始训练...")

    output_root = exports_dir(project.id) / "training_runs"
    output_root.mkdir(parents=True, exist_ok=True)
    # 续训时权重仍写入原 run 目录；新任务仅用于任务中心跟踪
    run_output_dir = (
        training_run_dir(project.id, resume_source_task_id)
        if resume and resume_source_task_id
        else output_root / run_name
    )
    request_path = dataset_dir / f"training-request-{task.id}.json"
    metrics_path = dataset_dir / f"training-metrics-{task.id}.json"
    request_path.write_text(
        json.dumps(
            {
                "mode": project.task_type.value,
                "base_model": base_model,
                "data": str(Path(data_path).resolve()),
                "epochs": epochs,
                "imgsz": imgsz,
                "batch": batch,
                "workers": workers,
                "device": device,
                "output_root": str(output_root.resolve()),
                "run_name": (
                    f"task_{resume_source_task_id}" if resume and resume_source_task_id else run_name
                ),
                "metrics_path": str(metrics_path.resolve()),
                "resume": resume,
                **{key: value for key, value in advanced.items() if value is not None},
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    training_log = dataset_dir / f"training-{task.id}.log"
    proc = subprocess.Popen(
        [sys.executable, "-m", "server.core.train_entry", "--params", str(request_path)],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
        cwd=str(Path(__file__).resolve().parent.parent.parent),
    )
    write_train_pid(project.id, task.id, proc.pid)
    tail: deque[str] = deque(maxlen=40)
    line_queue: Queue[str | None] = Queue()

    def read_output() -> None:
        assert proc.stdout is not None
        try:
            for output_line in proc.stdout:
                line_queue.put(output_line)
        finally:
            line_queue.put(None)

    reader = threading.Thread(target=read_output, daemon=True)
    reader.start()
    was_cancelled = False
    try:
        with training_log.open("w", encoding="utf-8") as output_file:
            while True:
                if cancelled and cancelled() and not was_cancelled:
                    was_cancelled = True
                    terminate_process_tree(proc.pid)
                try:
                    line = line_queue.get(timeout=0.2)
                except Empty:
                    if proc.poll() is not None and not reader.is_alive():
                        break
                    continue
                if line is None:
                    break
                output_file.write(line)
                output_file.flush()
                tail.append(line.rstrip())
                clean_line = _strip_ansi(line)
                epoch_match = re.match(r"^\s*(\d+)\s*/\s*(\d+)\s+\d+[GMK]?", clean_line)
                if epoch_match and int(epoch_match.group(2)) == epochs:
                    task.progress = min(int(epoch_match.group(1)), epochs)
                    task.heartbeat_at = datetime.now(timezone.utc)
                    db.commit()
                    if log:
                        log(clean_line.strip())
        reader.join(timeout=1.0)
        returncode = proc.wait()
    finally:
        clear_train_pid(project.id, task.id, proc.pid)
        if proc.poll() is None:
            terminate_process_tree(proc.pid)
            proc.wait(timeout=8)

    if was_cancelled:
        # 续训复用原目录，取消时不得删除断点权重与原数据集
        if not resume:
            if run_output_dir.exists():
                shutil.rmtree(run_output_dir)
            if dataset_dir.exists() and not reused_dataset:
                shutil.rmtree(dataset_dir)
        if log:
            log("训练已取消，训练进程树已终止")
        return

    if returncode != 0:
        raise RuntimeError("Training failed:\n" + "\n".join(list(tail)[-12:]))

    best_pt = run_output_dir / "weights" / "best.pt"
    if not best_pt.exists():
        raise RuntimeError(f"Current task best.pt not found: {best_pt}")

    version = db.query(ModelVersion).filter(ModelVersion.project_id == project.id).count() + 1
    out_path = models_dir(project.id) / f"v{version}_best.pt"
    shutil.copy2(best_pt, out_path)

    if not metrics_path.exists():
        raise RuntimeError("Training metrics file not found")
    metrics_payload = json.loads(metrics_path.read_text(encoding="utf-8"))
    metrics = metrics_payload.get("metrics", {})

    if dataset_version is None and requested_version_id:
        try:
            dataset_version = dataset_service.get_version(project.id, requested_version_id)
        except Exception:
            dataset_version = None

    mv = ModelVersion(
        project_id=project.id,
        version=version,
        name=f"v{version}",
        filepath=str(out_path),
        metrics=metrics,
        dataset_snapshot={
            **stats,
            "base_model": base_model,
            "output_dir": str(run_output_dir),
            "resumed": resume,
            "resume_from_task_id": resume_source_task_id or None,
        },
        task_id=task.id,
        dataset_version_id=dataset_version.id if dataset_version else None,
    )
    db.add(mv)
    task.progress = epochs
    task.result = {
        "model_path": str(out_path),
        "version": version,
        "metrics": metrics,
        "dataset": stats,
        "dataset_version_id": dataset_version.id if dataset_version else requested_version_id or None,
        "base_model": base_model,
        "device": metrics_payload.get("device", device),
        "output_dir": str(run_output_dir),
        "log_path": str(training_log),
        "resumed": resume,
        "resume_from_task_id": resume_source_task_id or None,
    }
    db.commit()
