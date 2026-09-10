"""训练参数 AI / 启发式建议。"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from sqlalchemy import func
from sqlalchemy.orm import Session

from server.config import settings
from server.core.builtin_yolo import list_builtin_weights
from server.db.models import Category, DatasetVersion, Frame, FrameStatus, ModelVersion, Project
from server.repositories.material_repository import active_frame_filter

logger = logging.getLogger(__name__)

TRAINABLE_STATUSES = (
    FrameStatus.AUTO_OK,
    FrameStatus.AUTO_FIXED,
    FrameStatus.HUMAN_OK,
    FrameStatus.NO_TARGET,
)

OPTIMIZERS = frozenset({"auto", "SGD", "Adam", "AdamW"})
SMALL_OBJECT_HINTS = (
    "nest",
    "鸟巢",
    "defect",
    "裂纹",
    "crack",
    "scratch",
    "划痕",
    "screw",
    "螺丝",
    "bolt",
    "pin",
    "针",
    "spark",
    "火花",
    "smoke",
    "烟",
    "leak",
    "泄漏",
    "tiny",
    "small",
    "微",
    "小目标",
)


@dataclass(frozen=True)
class HardwareProfile:
    accelerator: str  # cuda | mps | cpu
    gpu_name: str
    vram_gb: float | None
    vram_free_gb: float | None
    cpu_cores: int
    ram_gb: float | None
    ram_available_gb: float | None
    ram_used_percent: float | None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class SuggestedTrainParams:
    epochs: int
    imgsz: int
    batch: int
    base_model: str
    workers: int
    patience: int
    lr0: float
    optimizer: str
    seed: int
    close_mosaic: int
    weight_decay: float
    warmup_epochs: float


@dataclass(frozen=True)
class TrainParamsSuggestion:
    params: SuggestedTrainParams
    reason: str
    source: str  # llm | heuristic

    def to_dict(self) -> dict[str, Any]:
        return {
            "params": asdict(self.params),
            "reason": self.reason,
            "source": self.source,
        }


@dataclass(frozen=True)
class _SuggestContext:
    project_name: str
    task_type: str
    categories: tuple[dict[str, str], ...]
    sample_count: int
    train_count: int
    val_count: int
    test_count: int
    class_count: int
    allowed_base_models: tuple[str, ...]
    latest_project_model: str | None
    small_object_likely: bool
    hardware: HardwareProfile


def suggest_train_params(
    db: Session,
    project_id: str,
    dataset_version_id: str | None = None,
) -> dict[str, Any]:
    project = db.get(Project, project_id)
    if not project:
        raise LookupError("项目不存在")

    context = _build_context(db, project, dataset_version_id)
    baseline, baseline_reason = build_heuristic_suggestion(context)
    llm_result = refine_with_llm(context, baseline)
    if llm_result is None:
        logger.info(
            "训练参数建议完成 | 来源: heuristic | epochs: %s | batch: %s | base_model: %s | 加速器: %s",
            baseline.epochs,
            baseline.batch,
            baseline.base_model,
            context.hardware.accelerator,
        )
        return TrainParamsSuggestion(params=baseline, reason=baseline_reason, source="heuristic").to_dict()

    clamped = clamp_suggested_params(llm_result["params"], context, baseline)
    reason = str(llm_result.get("reason") or "").strip() or baseline_reason
    raw_params = llm_result["params"] if isinstance(llm_result.get("params"), dict) else {}
    try:
        raw_workers = int(raw_params.get("workers"))
    except (TypeError, ValueError):
        raw_workers = clamped.workers
    if raw_workers > clamped.workers:
        reason = f"{reason.rstrip('。')}；workers 已按本机上限调整为 {clamped.workers}"
    logger.info(
        "训练参数建议完成 | 来源: llm | epochs: %s | batch: %s | base_model: %s | 加速器: %s",
        clamped.epochs,
        clamped.batch,
        clamped.base_model,
        context.hardware.accelerator,
    )
    return TrainParamsSuggestion(params=clamped, reason=reason, source="llm").to_dict()


def probe_hardware() -> HardwareProfile:
    """探测本机训练相关硬件与当前可用内存；失败时回退到保守 CPU 画像。"""
    cpu_cores = max(1, os.cpu_count() or 1)
    ram_gb: float | None = None
    ram_available_gb: float | None = None
    ram_used_percent: float | None = None
    try:
        import psutil

        mem = psutil.virtual_memory()
        ram_gb = round(mem.total / (1024**3), 1)
        ram_available_gb = round(mem.available / (1024**3), 1)
        ram_used_percent = round(float(mem.percent), 1)
    except Exception:
        ram_gb = None

    accelerator = "cpu"
    gpu_name = ""
    vram_gb: float | None = None
    vram_free_gb: float | None = None
    try:
        import torch

        if torch.cuda.is_available():
            accelerator = "cuda"
            index = torch.cuda.current_device()
            props = torch.cuda.get_device_properties(index)
            gpu_name = str(getattr(props, "name", "") or f"cuda:{index}")
            total = float(getattr(props, "total_memory", 0) or 0)
            if total > 0:
                vram_gb = round(total / (1024**3), 1)
            try:
                free_bytes, total_bytes = torch.cuda.mem_get_info(index)
                if total_bytes:
                    vram_gb = vram_gb or round(total_bytes / (1024**3), 1)
                if free_bytes is not None:
                    vram_free_gb = round(free_bytes / (1024**3), 1)
            except Exception:
                vram_free_gb = None
        else:
            mps = getattr(torch.backends, "mps", None)
            if mps is not None and mps.is_available():
                accelerator = "mps"
                gpu_name = "Apple MPS"
    except Exception as error:
        logger.warning("硬件探测失败，按 CPU 保守建议 | 错误: %s", error)

    profile = HardwareProfile(
        accelerator=accelerator,
        gpu_name=gpu_name,
        vram_gb=vram_gb,
        vram_free_gb=vram_free_gb,
        cpu_cores=cpu_cores,
        ram_gb=ram_gb,
        ram_available_gb=ram_available_gb,
        ram_used_percent=ram_used_percent,
    )
    logger.info(
        "训练硬件画像 | 加速器: %s | GPU: %s | 显存: %sGB(可用%sGB) | CPU: %s核 | 内存: %sGB(可用%sGB, 占用%s%%)",
        profile.accelerator,
        profile.gpu_name or "-",
        profile.vram_gb if profile.vram_gb is not None else "-",
        profile.vram_free_gb if profile.vram_free_gb is not None else "-",
        profile.cpu_cores,
        profile.ram_gb if profile.ram_gb is not None else "-",
        profile.ram_available_gb if profile.ram_available_gb is not None else "-",
        profile.ram_used_percent if profile.ram_used_percent is not None else "-",
    )
    return profile


def _build_context(
    db: Session,
    project: Project,
    dataset_version_id: str | None,
) -> _SuggestContext:
    task_type = project.task_type.value if hasattr(project.task_type, "value") else str(project.task_type)
    categories = (
        db.query(Category)
        .filter(Category.project_id == project.id)
        .order_by(Category.class_id)
        .all()
    )
    category_payload = tuple(
        {"name": item.name, "description": item.description or ""} for item in categories
    )
    class_names = [item.name for item in categories]

    sample_count = 0
    train_count = 0
    val_count = 0
    test_count = 0
    class_count = len(categories)

    if dataset_version_id:
        version = (
            db.query(DatasetVersion)
            .filter(
                DatasetVersion.id == dataset_version_id,
                DatasetVersion.project_id == project.id,
            )
            .first()
        )
        if version:
            frames = (version.manifest or {}).get("frames") or []
            split_counts = {"train": 0, "val": 0, "test": 0}
            for entry in frames:
                split = str(entry.get("split") or "")
                if split in split_counts:
                    split_counts[split] += 1
            sample_count = len(frames)
            train_count = split_counts["train"]
            val_count = split_counts["val"]
            test_count = split_counts["test"]
            class_count = len(version.categories or []) or class_count

    if sample_count <= 0:
        trainable = (
            db.query(func.count(Frame.id))
            .filter(
                Frame.project_id == project.id,
                Frame.status.in_(TRAINABLE_STATUSES),
                active_frame_filter(),
            )
            .scalar()
        )
        sample_count = int(trainable or 0)
        train_count = sample_count
        val_count = 0
        test_count = 0

    builtins = [item.filename for item in list_builtin_weights(task_type)]
    project_models = (
        db.query(ModelVersion)
        .filter(ModelVersion.project_id == project.id)
        .order_by(ModelVersion.version.desc())
        .all()
    )
    project_paths = [item.filepath for item in project_models if item.filepath]
    allowed = tuple(dict.fromkeys([*builtins, *project_paths]))
    latest_project_model = project_paths[0] if project_paths else None
    small_object_likely = _looks_like_small_object(class_names, [c.description for c in categories])

    return _SuggestContext(
        project_name=project.name,
        task_type=task_type,
        categories=category_payload,
        sample_count=sample_count,
        train_count=train_count,
        val_count=val_count,
        test_count=test_count,
        class_count=class_count,
        allowed_base_models=allowed,
        latest_project_model=latest_project_model,
        small_object_likely=small_object_likely,
        hardware=probe_hardware(),
    )


def _looks_like_small_object(names: list[str], descriptions: list[str]) -> bool:
    blob = " ".join([*names, *descriptions]).lower()
    return any(hint.lower() in blob for hint in SMALL_OBJECT_HINTS)


def _suggest_workers(hardware: HardwareProfile) -> int:
    import sys

    cores = max(1, hardware.cpu_cores)
    available = hardware.ram_available_gb
    # 可用内存紧张时直接关掉多进程，优先避免 MemoryError
    if available is not None and available < 10:
        return 0
    if hardware.accelerator == "cpu":
        return min(2, max(0, cores // 4))
    # Windows 上 YOLO DataLoader 多进程容易把标签缓存复制多份导致 MemoryError
    if sys.platform.startswith("win"):
        if available is not None and available < 20:
            return 0
        return min(2, max(0, cores // 8))
    if available is not None and available < 16:
        return min(2, max(0, cores // 4))
    return min(8, max(2, cores // 2))


def _memory_pressure_level(hardware: HardwareProfile) -> str:
    """返回 low / medium / high，用于收紧 batch/workers/模型。"""
    available = hardware.ram_available_gb
    used = hardware.ram_used_percent
    if available is not None:
        if available < 8:
            return "high"
        if available < 16:
            return "medium"
    if used is not None:
        if used >= 85:
            return "high"
        if used >= 70:
            return "medium"
    free_vram = hardware.vram_free_gb
    total_vram = hardware.vram_gb
    if free_vram is not None and total_vram:
        ratio = free_vram / max(total_vram, 0.1)
        if ratio < 0.25:
            return "high"
        if ratio < 0.45:
            return "medium"
    return "low"


def _batch_cap(hardware: HardwareProfile, *, size_key: str = "s") -> int:
    if hardware.accelerator == "cpu":
        return 8
    vram = hardware.vram_gb or 0
    # 大模型额外收紧，避免“显存看似够、系统内存先爆”
    size_penalty = {"n": 0, "s": 0, "m": 8, "l": 16}.get(size_key, 0)
    if vram >= 20:
        cap = 64
    elif vram >= 12:
        cap = 48
    elif vram >= 8:
        cap = 32
    elif vram >= 4:
        cap = 16
    else:
        cap = 8
    pressure = _memory_pressure_level(hardware)
    if pressure == "high":
        cap = min(cap, 16 if size_key in {"n", "s"} else 8)
    elif pressure == "medium":
        cap = min(cap, 32 if size_key in {"n", "s"} else 24)
    return max(4, cap - size_penalty)


def estimate_batch_for_hardware(
    hardware: HardwareProfile,
    *,
    size_key: str,
    imgsz: int,
) -> int:
    """按显存与当前可用内存粗估 batch。"""
    cap = _batch_cap(hardware, size_key=size_key)
    if hardware.accelerator == "cpu" or not hardware.vram_gb:
        return min(8, cap)

    # 优先用“当前空闲显存”，没有再退回总显存
    budget_vram = hardware.vram_free_gb if hardware.vram_free_gb is not None else hardware.vram_gb
    # 经验：yolov8s @640 batch16 ≈ 4.5GB → 约 0.28GB/图
    per_image_gb = {"n": 0.16, "s": 0.28, "m": 0.42, "l": 0.65}.get(size_key, 0.28)
    per_image_gb *= (max(320, imgsz) / 640) ** 2
    usable_gb = max(1.0, budget_vram) * 0.68
    raw = usable_gb / max(0.08, per_image_gb)

    # 系统可用内存也要卡一道：每个 worker/batch 都会吃 host RAM
    available = hardware.ram_available_gb
    if available is not None:
        # 粗略：batch 每 +8 大约额外占用更多 host 缓存，可用内存低时压低
        if available < 8:
            raw = min(raw, 8)
        elif available < 16:
            raw = min(raw, 24)
        elif available < 24:
            raw = min(raw, 32)

    candidates = (4, 8, 12, 16, 24, 32, 40, 48, 64)
    fitted = [item for item in candidates if item <= raw + 0.5]
    batch = fitted[-1] if fitted else 4
    return max(4, min(cap, batch))


def build_heuristic_suggestion(context: _SuggestContext) -> tuple[SuggestedTrainParams, str]:
    is_classify = context.task_type == "classify"
    n = max(0, context.sample_count)
    continue_finetune = bool(context.latest_project_model)
    hardware = context.hardware

    if n < 500:
        size_key = "n"
        epochs = 120
    elif n < 5000:
        size_key = "s"
        epochs = 80
    elif n < 20000:
        size_key = "m"
        epochs = 60
    else:
        size_key = "m"
        epochs = 50

    if context.small_object_likely and size_key == "n":
        size_key = "s"
    if context.small_object_likely and n >= 2000 and size_key == "s":
        size_key = "m"
    pressure = _memory_pressure_level(hardware)
    # 大显存且内存宽松时可适度上探模型
    if (
        pressure == "low"
        and hardware.accelerator == "cuda"
        and (hardware.vram_gb or 0) >= 12
        and n >= 3000
        and size_key == "s"
    ):
        size_key = "m"
    if pressure == "high" and size_key in {"m", "l"}:
        size_key = "s"

    imgsz = 640
    if context.small_object_likely and n >= 1000:
        # 大显存才抬分辨率，避免把 batch 压太低导致 GPU 吃不饱
        if hardware.accelerator == "cuda" and (hardware.vram_gb or 0) >= 16:
            imgsz = 768
        elif hardware.accelerator == "cuda" and (hardware.vram_gb or 0) >= 10:
            imgsz = 640
        else:
            imgsz = 640

    imgsz = _align_imgsz(imgsz)
    batch = estimate_batch_for_hardware(hardware, size_key=size_key, imgsz=imgsz)
    workers = _suggest_workers(hardware)

    hw_note = _hardware_reason_fragment(hardware)

    if continue_finetune:
        base_model = context.latest_project_model or _default_builtin(is_classify, size_key)
        lr0 = 0.001
        epochs = min(epochs, 60)
        reason = (
            f"已有本项目权重，建议继续微调；样本约 {n} 张，"
            f"建议 {epochs} epoch、batch {batch}、imgsz {imgsz}"
            f"；{hw_note}"
        )
    else:
        base_model = _pick_builtin(context.allowed_base_models, is_classify, size_key)
        lr0 = 0.01
        reason = (
            f"样本约 {n} 张、类别 {context.class_count} 个，"
            f"建议基座 {base_model}、{epochs} epoch、batch {batch}、workers {workers}"
            f"；{hw_note}"
        )
        if context.small_object_likely:
            reason += "；目标偏小，兼顾分辨率与模型容量"

    patience = max(10, min(50, epochs // 2))
    close_mosaic = 0 if is_classify else min(10, max(0, epochs // 8))
    params = SuggestedTrainParams(
        epochs=epochs,
        imgsz=imgsz,
        batch=batch,
        base_model=base_model,
        workers=workers,
        patience=patience,
        lr0=lr0,
        optimizer="auto",
        seed=0,
        close_mosaic=close_mosaic,
        weight_decay=0.0005,
        warmup_epochs=3.0,
    )
    return params, reason


def _hardware_reason_fragment(hardware: HardwareProfile) -> str:
    pressure = _memory_pressure_level(hardware)
    pressure_zh = {"low": "内存宽松", "medium": "内存一般", "high": "内存紧张"}[pressure]
    avail = (
        f"系统可用约 {hardware.ram_available_gb:g}GB"
        if hardware.ram_available_gb is not None
        else "系统可用内存未知"
    )
    if hardware.accelerator == "cuda":
        name = hardware.gpu_name or "CUDA GPU"
        if hardware.vram_free_gb is not None and hardware.vram_gb is not None:
            vram = f"显存 {hardware.vram_free_gb:g}/{hardware.vram_gb:g}GB 可用"
        elif hardware.vram_gb is not None:
            vram = f"{hardware.vram_gb:g}GB 显存"
        else:
            vram = "显存未知"
        return f"本机 {name}（{vram}），{avail}（{pressure_zh}），按实时资源给 batch/workers"
    if hardware.accelerator == "mps":
        return f"本机 Apple MPS，{avail}（{pressure_zh}），batch 保守"
    return f"本机无可用 GPU，{avail}（{pressure_zh}），按 CPU 保守建议"


def _default_builtin(is_classify: bool, size_key: str) -> str:
    if is_classify:
        return {"n": "yolov8n-cls.pt", "s": "yolov8s-cls.pt", "m": "yolov8m-cls.pt"}.get(
            size_key, "yolov8s-cls.pt"
        )
    return {"n": "yolov8n.pt", "s": "yolov8s.pt", "m": "yolov8m.pt", "l": "yolov8l.pt"}.get(
        size_key, "yolov8s.pt"
    )


def _infer_size_key(base_model: str) -> str:
    name = Path(base_model).name.lower()
    for key in ("yolov8l", "yolo11l", "yolov8m", "yolo11m", "yolov8s", "yolo11s", "yolov8n", "yolo11n"):
        if key in name:
            return key[-1]
    return "s"


def _pick_builtin(allowed: tuple[str, ...], is_classify: bool, size_key: str) -> str:
    preferred = _default_builtin(is_classify, size_key)
    if preferred in allowed:
        return preferred
    builtins = [item for item in allowed if item.endswith(".pt") and "/" not in item and "\\" not in item]
    return builtins[0] if builtins else preferred


def _align_imgsz(value: int) -> int:
    clamped = max(320, min(1280, int(value)))
    return max(320, min(1280, round(clamped / 32) * 32))


def clamp_suggested_params(
    raw: dict[str, Any],
    context: _SuggestContext,
    baseline: SuggestedTrainParams,
) -> SuggestedTrainParams:
    is_classify = context.task_type == "classify"
    epochs = _clamp_int(raw.get("epochs"), baseline.epochs, 1, 1000)
    imgsz = _align_imgsz(_clamp_int(raw.get("imgsz"), baseline.imgsz, 320, 1280))
    batch_cap = _batch_cap(context.hardware, size_key=_infer_size_key(str(raw.get("base_model") or baseline.base_model)))
    batch = _clamp_int(raw.get("batch"), baseline.batch, 1, batch_cap)
    import sys

    if _memory_pressure_level(context.hardware) == "high":
        workers_cap = 0
    elif sys.platform.startswith("win"):
        workers_cap = 2 if (context.hardware.ram_available_gb or 99) >= 20 else 0
    else:
        workers_cap = min(8, max(2, context.hardware.cpu_cores // 2))
    workers = _clamp_int(raw.get("workers"), baseline.workers, 0, workers_cap)
    patience = _clamp_int(raw.get("patience"), baseline.patience, 0, epochs)
    lr0 = _clamp_float(raw.get("lr0"), baseline.lr0, 0.0001, 0.1)
    optimizer = str(raw.get("optimizer") or baseline.optimizer)
    if optimizer not in OPTIMIZERS:
        optimizer = baseline.optimizer
    seed = _clamp_int(raw.get("seed"), baseline.seed, 0, 2_147_483_647)
    close_mosaic = 0 if is_classify else _clamp_int(
        raw.get("close_mosaic"), baseline.close_mosaic, 0, epochs
    )
    weight_decay = _clamp_float(raw.get("weight_decay"), baseline.weight_decay, 0.0, 0.01)
    warmup_epochs = _clamp_float(raw.get("warmup_epochs"), baseline.warmup_epochs, 0.0, 10.0)

    base_model = str(raw.get("base_model") or "").strip()
    if base_model not in context.allowed_base_models:
        base_model = baseline.base_model

    return SuggestedTrainParams(
        epochs=epochs,
        imgsz=imgsz,
        batch=batch,
        base_model=base_model,
        workers=workers,
        patience=patience,
        lr0=lr0,
        optimizer=optimizer,
        seed=seed,
        close_mosaic=close_mosaic,
        weight_decay=weight_decay,
        warmup_epochs=warmup_epochs,
    )


def _clamp_int(value: Any, default: int, low: int, high: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = default
    return max(low, min(high, number))


def _clamp_float(value: Any, default: float, low: float, high: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        number = default
    return max(low, min(high, number))


def refine_with_llm(
    context: _SuggestContext,
    baseline: SuggestedTrainParams,
) -> dict[str, Any] | None:
    api_key = settings.dashscope_api_key or os.environ.get("DASHSCOPE_API_KEY", "")
    if not api_key:
        return None
    try:
        from openai import OpenAI

        text_model = os.environ.get("LABELKIT_TEXT_MODEL", "qwen-plus")
        payload = {
            "project": context.project_name,
            "task_type": context.task_type,
            "categories": list(context.categories),
            "sample_count": context.sample_count,
            "train_count": context.train_count,
            "val_count": context.val_count,
            "test_count": context.test_count,
            "class_count": context.class_count,
            "small_object_likely": context.small_object_likely,
            "allowed_base_models": list(context.allowed_base_models),
            "hardware": context.hardware.to_dict(),
            "batch_cap": _batch_cap(
                context.hardware,
                size_key=_infer_size_key(baseline.base_model),
            ),
            "heuristic_draft": asdict(baseline),
        }
        response = OpenAI(api_key=api_key, base_url=settings.vlm_base_url, timeout=20).chat.completions.create(
            model=text_model,
            temperature=0,
            response_format={"type": "json_object"},
            max_tokens=700,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "你是 YOLO 训练超参顾问。必须同时参考数据集硬数据与 hardware 实时资源画像。"
                        "重点看 ram_available_gb、ram_used_percent、vram_free_gb，不要只看总量。"
                        "可用内存紧张时优先降低 batch/workers，必要时选更小基座，避免 MemoryError。"
                        "有 CUDA 且显存与系统内存都充裕时，可提高 batch（不超过 batch_cap）。"
                        "Windows 上 workers 建议 0~2；内存紧张时 workers=0。"
                        "不要编造不在 allowed_base_models 中的基座路径；不要输出 device 字段。"
                        "只返回 JSON："
                        '{"params":{"epochs":int,"imgsz":int,"batch":int,"base_model":str,'
                        '"workers":int,"patience":int,"lr0":float,"optimizer":str,"seed":int,'
                        '"close_mosaic":int,"weight_decay":float,"warmup_epochs":float},'
                        '"reason":"一两句中文理由，可点明硬件依据"}。'
                        "imgsz 应为 32 的倍数；optimizer 仅限 auto/SGD/Adam/AdamW；"
                        "可微调 heuristic_draft，但需贴合样本量、小目标与显存。"
                    ),
                },
                {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
            ],
        )
        content = response.choices[0].message.content or "{}"
        parsed = json.loads(content)
        params = parsed.get("params")
        if not isinstance(params, dict):
            return None
        reason = parsed.get("reason")
        return {"params": params, "reason": reason if isinstance(reason, str) else ""}
    except Exception as error:
        logger.warning("训练参数 LLM 建议失败 | 错误: %s", error)
        return None
