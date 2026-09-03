"""Built-in catalog content displayed by the global model center."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Iterable, Mapping


@dataclass(frozen=True)
class CatalogStat:
    label: str
    value: str
    change: str
    icon: str


@dataclass(frozen=True)
class CatalogMetric:
    label: str
    value: str
    change: str
    direction: str = "up"


@dataclass(frozen=True)
class CatalogItem:
    id: str
    name: str
    version: str
    category: str
    description: str
    icon: str
    framework: str
    task: str
    status: str
    metrics: tuple[CatalogMetric, CatalogMetric]
    updated_at: str
    source: str = "内置模型"
    project_name: str | None = None
    project_id: str | None = None
    model_id: str | None = None


@dataclass(frozen=True)
class TrainingModel:
    """A project model version prepared by the API layer for catalog display."""

    id: str
    project_id: str
    name: str
    version: int
    project_name: str
    task_type: str
    metrics: Mapping[str, object]
    base_model: str
    updated_at: str
    source: str = "训练模型"


CATALOG_STATS = (
    CatalogStat("模型总数", "76", "11%", "cube"),
    CatalogStat("评估总次数", "2,863,421", "8.4%", "layers"),
    CatalogStat("运行中模型", "89", "5%", "users"),
    CatalogStat("部署总次数", "1,42,678", "15%", "clock"),
)

CATALOG_MODELS = (
    CatalogItem("yolov8", "YOLOv8", "v8.2", "计算机视觉", "先进的实时目标检测模型，兼顾速度与识别精度。", "yolo", "PyTorch", "目标检测", "运行中", (CatalogMetric("mAP@0.5", "92.4%", "2.3%"), CatalogMetric("准确率", "95.1%", "1.8%")), "2024年5月28日"),
    CatalogItem("resnet50", "ResNet50", "v2.1", "图像分类", "用于图像分类的深度残差学习模型。", "network", "PyTorch", "图像分类", "运行中", (CatalogMetric("Top-1 准确率", "93.7%", "1.6%"), CatalogMetric("Top-5 准确率", "98.1%", "1.2%")), "2024年5月22日"),
    CatalogItem("pp-ocrv4", "PP-OCRv4", "v4.0", "文字识别", "面向文字检测与识别的高性能 OCR 模型。", "ocr", "PaddlePaddle", "文字识别", "运行中", (CatalogMetric("mAP", "89.6%", "2.1%"), CatalogMetric("准确率", "94.0%", "1.7%")), "2024年5月20日"),
    CatalogItem("wav2vec2", "Wav2Vec 2.0", "v2.0", "语音识别", "用于自动语音识别的自监督学习模型。", "audio", "PyTorch", "语音识别", "运行中", (CatalogMetric("词错误率", "7.6%", "0.8%", "down"), CatalogMetric("字错误率", "2.1%", "0.4%", "down")), "2024年5月18日"),
    CatalogItem("pointnet", "PointNet++", "v1.3", "三维点云", "用于三维点云分类与分割的深度学习模型。", "cube", "PyTorch", "三维分类", "运行中", (CatalogMetric("mIoU", "88.2%", "2.7%"), CatalogMetric("准确率", "91.3%", "2.0%")), "2024年5月16日"),
    CatalogItem("efficientnet", "EfficientNet-B4", "v1.2", "图像分类", "兼顾识别精度与推理效率的高效卷积网络。", "chart", "TensorFlow", "图像分类", "运行中", (CatalogMetric("Top-1 准确率", "92.2%", "1.4%"), CatalogMetric("Top-5 准确率", "97.5%", "1.1%")), "2024年5月14日"),
)


def _percent(metrics: Mapping[str, object], *keys: str) -> str:
    for key in keys:
        value = metrics.get(key)
        if isinstance(value, (int, float)):
            return f"{value * 100:.1f}%"
    return "—"


def _training_catalog_item(model: TrainingModel) -> CatalogItem:
    task = "目标检测" if model.task_type == "detect" else "图像分类"
    category = "项目训练"
    base_model = model.base_model or "自定义基座模型"
    return CatalogItem(
        id=f"trained-{model.id}",
        name=model.name,
        version=f"v{model.version}",
        category=category,
        description=f"来自「{model.project_name}」的训练版本，基于 {base_model}。",
        icon="yolo",
        framework="PyTorch",
        task=task,
        status="可部署",
        metrics=(
            CatalogMetric("mAP@0.5", _percent(model.metrics, "metrics/mAP50(B)", "mAP50", "map50"), "", "neutral"),
            CatalogMetric("精确率", _percent(model.metrics, "metrics/precision(B)", "precision"), "", "neutral"),
        ),
        updated_at=model.updated_at,
        source=model.source,
        project_name=model.project_name,
        project_id=model.project_id,
        model_id=model.id,
    )


def get_model_catalog(training_models: Iterable[TrainingModel] = ()) -> dict:
    """Return built-in models together with completed project training versions."""

    trained_items = tuple(_training_catalog_item(model) for model in training_models)
    models = (*trained_items, *CATALOG_MODELS)
    total = len(models)
    stats = list(CATALOG_STATS)
    stats[0] = CatalogStat("模型总数", str(total), "", "cube")

    return {
        "stats": [asdict(item) for item in stats],
        "models": [asdict(item) for item in models],
        "total": total,
    }
