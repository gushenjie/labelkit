"""官方 YOLO 预训练权重：全局缓存 + 注册到项目模型中心。"""

from __future__ import annotations

import logging
import shutil
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import func
from sqlalchemy.orm import Session

from server.config import settings
from server.core.paths import models_dir
from server.db.models import ModelVersion, Project, ProjectTaskType

logger = logging.getLogger(__name__)

# Ultralytics 官方资产（GitHub Releases）
_ASSET_BASE = "https://github.com/ultralytics/assets/releases/download/v8.3.0"


@dataclass(frozen=True)
class BuiltinYoloWeight:
    key: str
    name: str
    task: str  # detect | classify
    hint: str
    filename: str


BUILTIN_YOLO_WEIGHTS: tuple[BuiltinYoloWeight, ...] = (
    BuiltinYoloWeight("yolov8n", "YOLOv8n", "detect", "最快 / 精度较低", "yolov8n.pt"),
    BuiltinYoloWeight("yolov8s", "YOLOv8s", "detect", "默认平衡", "yolov8s.pt"),
    BuiltinYoloWeight("yolov8m", "YOLOv8m", "detect", "更准 / 更慢", "yolov8m.pt"),
    BuiltinYoloWeight("yolov8l", "YOLOv8l", "detect", "高精度", "yolov8l.pt"),
    BuiltinYoloWeight("yolo11n", "YOLO11n", "detect", "新一代轻量", "yolo11n.pt"),
    BuiltinYoloWeight("yolo11s", "YOLO11s", "detect", "新一代平衡", "yolo11s.pt"),
    BuiltinYoloWeight("yolov8n-cls", "YOLOv8n-cls", "classify", "分类 · 最快", "yolov8n-cls.pt"),
    BuiltinYoloWeight("yolov8s-cls", "YOLOv8s-cls", "classify", "分类 · 默认平衡", "yolov8s-cls.pt"),
    BuiltinYoloWeight("yolov8m-cls", "YOLOv8m-cls", "classify", "分类 · 更准", "yolov8m-cls.pt"),
    BuiltinYoloWeight("yolo11n-cls", "YOLO11n-cls", "classify", "分类 · 新一代轻量", "yolo11n-cls.pt"),
    BuiltinYoloWeight("yolo11s-cls", "YOLO11s-cls", "classify", "分类 · 新一代平衡", "yolo11s-cls.pt"),
)

_BY_KEY = {item.key: item for item in BUILTIN_YOLO_WEIGHTS}
_BY_FILENAME = {item.filename: item for item in BUILTIN_YOLO_WEIGHTS}


def builtin_models_cache_dir() -> Path:
    d = settings.data_dir / "builtin_models"
    d.mkdir(parents=True, exist_ok=True)
    return d


def list_builtin_weights(task_type: str | None = None) -> list[BuiltinYoloWeight]:
    if not task_type:
        return list(BUILTIN_YOLO_WEIGHTS)
    return [item for item in BUILTIN_YOLO_WEIGHTS if item.task == task_type]


def resolve_builtin(key_or_filename: str) -> BuiltinYoloWeight | None:
    key = key_or_filename.strip()
    if key in _BY_KEY:
        return _BY_KEY[key]
    if key.endswith(".pt") and key in _BY_FILENAME:
        return _BY_FILENAME[key]
    stem = Path(key).stem
    return _BY_KEY.get(stem)


def ensure_weight_cached(weight: BuiltinYoloWeight, *, timeout: int = 300) -> Path:
    """确保官方权重在全局缓存中；优先复用本机已有文件，再尝试下载。"""
    dest = builtin_models_cache_dir() / weight.filename
    min_bytes = 1_000_000
    if dest.exists() and dest.stat().st_size >= min_bytes:
        return dest
    if dest.exists():
        dest.unlink(missing_ok=True)

    # 常见本机落点：仓库根目录、weights/、Ultralytics 缓存
    search_roots = [
        Path.cwd(),
        Path.cwd() / "weights",
        Path.home() / "AppData" / "Roaming" / "Ultralytics",
        Path.home() / ".cache" / "ultralytics",
    ]
    for root in search_roots:
        if not root.exists():
            continue
        for candidate in (root / weight.filename, *root.rglob(weight.filename)):
            try:
                if candidate.is_file() and candidate.stat().st_size >= min_bytes:
                    shutil.copy2(candidate, dest)
                    logger.info("已从本机复用官方权重 | 模型: %s | 来源: %s", weight.filename, candidate)
                    return dest
            except OSError:
                continue

    # Ultralytics 自带下载（可能已有镜像/缓存）
    try:
        from ultralytics import YOLO

        model = YOLO(weight.filename)
        ckpt = getattr(model, "ckpt_path", None) or getattr(model, "ckpt", None)
        source = Path(str(ckpt)) if ckpt else None
        if source is None or not source.exists():
            # YOLO() 常把权重落到当前工作目录
            cwd_hit = Path.cwd() / weight.filename
            source = cwd_hit if cwd_hit.exists() else None
        if source and source.exists() and source.stat().st_size >= min_bytes:
            if source.resolve() != dest.resolve():
                shutil.copy2(source, dest)
            logger.info("已通过 Ultralytics 获取官方权重 | 模型: %s", weight.filename)
            return dest
    except Exception as error:
        logger.warning("Ultralytics 获取权重失败 | 模型: %s | 错误: %s", weight.filename, error)

    url = f"{_ASSET_BASE}/{weight.filename}"
    tmp = dest.with_suffix(dest.suffix + ".part")
    logger.info("开始下载官方预训练权重 | 模型: %s | 目标: %s", weight.filename, dest)
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response, tmp.open("wb") as out:
            shutil.copyfileobj(response, out)
    except urllib.error.URLError as error:
        tmp.unlink(missing_ok=True)
        raise RuntimeError(f"下载官方权重失败：{weight.filename}（{error}）") from error
    except Exception:
        tmp.unlink(missing_ok=True)
        raise

    if not tmp.exists() or tmp.stat().st_size < min_bytes:
        tmp.unlink(missing_ok=True)
        raise RuntimeError(f"下载官方权重无效：{weight.filename}")
    tmp.replace(dest)
    logger.info("官方预训练权重已缓存 | 模型: %s | 大小: %s 字节", weight.filename, dest.stat().st_size)
    return dest


def _already_registered(db: Session, project_id: str, weight: BuiltinYoloWeight) -> ModelVersion | None:
    rows = (
        db.query(ModelVersion)
        .filter(ModelVersion.project_id == project_id)
        .order_by(ModelVersion.version.desc())
        .all()
    )
    for row in rows:
        metrics = row.metrics or {}
        if metrics.get("origin") != "builtin":
            continue
        if metrics.get("builtin_key") == weight.key or metrics.get("ultralytics_name") == weight.filename:
            # 清理此前误写入的过小文件
            path = Path(row.filepath)
            if path.exists() and path.stat().st_size < 1_000_000:
                continue
            return row
        if Path(row.filepath).name == f"builtin_{weight.filename}":
            path = Path(row.filepath)
            if path.exists() and path.stat().st_size < 1_000_000:
                continue
            return row
    return None


def register_builtin_weights(
    db: Session,
    project: Project,
    keys: list[str] | None = None,
) -> dict:
    """下载（如需）并注册官方 YOLO 权重到项目模型中心。"""
    task = project.task_type.value if isinstance(project.task_type, ProjectTaskType) else str(project.task_type)
    if keys:
        selected: list[BuiltinYoloWeight] = []
        for raw in keys:
            item = resolve_builtin(raw)
            if not item:
                raise ValueError(f"未知官方权重：{raw}")
            if item.task != task:
                raise ValueError(f"权重 {item.filename} 与项目任务类型 {task} 不匹配")
            selected.append(item)
    else:
        selected = list_builtin_weights(task)

    created: list[ModelVersion] = []
    skipped: list[str] = []
    downloaded: list[str] = []
    failed: list[str] = []

    max_ver = (
        db.query(func.max(ModelVersion.version)).filter(ModelVersion.project_id == project.id).scalar() or 0
    )
    dest_root = models_dir(project.id)

    for weight in selected:
        existing = _already_registered(db, project.id, weight)
        if existing:
            skipped.append(weight.key)
            continue

        cache_before = builtin_models_cache_dir() / weight.filename
        existed = cache_before.exists() and cache_before.stat().st_size >= 1_000_000
        try:
            cached = ensure_weight_cached(weight)
        except Exception as error:
            logger.warning("注册官方权重失败 | 模型: %s | 错误: %s", weight.filename, error)
            failed.append(f"{weight.key}: {error}")
            continue
        if not existed:
            downloaded.append(weight.filename)

        max_ver += 1
        dest = dest_root / f"builtin_{weight.filename}"
        if not dest.exists() or dest.stat().st_size != cached.stat().st_size:
            shutil.copy2(cached, dest)

        display = f"{weight.name}（{weight.hint}）" if weight.hint else weight.name
        mv = ModelVersion(
            project_id=project.id,
            version=max_ver,
            name=display,
            filepath=str(dest),
            metrics={
                "origin": "builtin",
                "builtin_key": weight.key,
                "ultralytics_name": weight.filename,
                "task": weight.task,
            },
            dataset_snapshot={"base_model": weight.filename, "origin": "builtin"},
            task_id=None,
        )
        db.add(mv)
        created.append(mv)

    if created:
        db.commit()
        for mv in created:
            db.refresh(mv)

    if not created and failed and not skipped:
        raise RuntimeError("官方预训练注册失败：" + "；".join(failed[:3]))

    return {
        "created": created,
        "skipped_keys": skipped,
        "downloaded": downloaded,
        "failed": failed,
        "task_type": task,
    }
