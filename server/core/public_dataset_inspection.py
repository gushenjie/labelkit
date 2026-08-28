"""Detect and validate supported public dataset layouts."""

from __future__ import annotations

import json
import math
from collections import Counter, defaultdict
from pathlib import Path

import cv2
import yaml

from server.core.dedup import compute_phash
from server.core.public_dataset_archive import sha256_file
from server.core.public_dataset_types import DatasetInspectionDTO, ManifestEntryDTO, SourceLabelDTO
from server.core.yolo_io import parse_labels


IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}
VALID_SPLITS = {"train", "val", "test"}


def _require_within(path: Path, root: Path, description: str) -> Path:
    resolved = path.resolve()
    resolved_root = root.resolve()
    if resolved != resolved_root and resolved_root not in resolved.parents:
        raise RuntimeError(f"{description}超出数据集解压目录: {path}")
    return resolved


def _images_under(path: Path) -> list[Path]:
    if path.is_file() and path.suffix.lower() in IMAGE_SUFFIXES:
        return [path]
    if not path.is_dir():
        return []
    return sorted(item for item in path.rglob("*") if item.is_file() and item.suffix.lower() in IMAGE_SUFFIXES)


def _validate_image(path: Path) -> tuple[int, int]:
    image = cv2.imread(str(path))
    if image is None or image.size == 0:
        raise RuntimeError(f"图片损坏或无法读取: {path}")
    height, width = image.shape[:2]
    return width, height


def _validate_box(label: SourceLabelDTO, source: str) -> None:
    values = (label.x_center, label.y_center, label.width, label.height)
    if any(value is None for value in values):
        raise RuntimeError(f"检测框字段不完整: {source}")
    xc, yc, width, height = (float(value) for value in values)
    if not all(math.isfinite(value) for value in (xc, yc, width, height)):
        raise RuntimeError(f"检测框包含非有限值: {source}")
    if width <= 0 or height <= 0:
        raise RuntimeError(f"检测框宽高必须大于 0: {source}")
    if xc - width / 2 < 0 or yc - height / 2 < 0 or xc + width / 2 > 1 or yc + height / 2 > 1:
        raise RuntimeError(f"检测框超出图片边界: {source}")


def _entry(root: Path, image: Path, split: str, labels: tuple[SourceLabelDTO, ...]) -> ManifestEntryDTO:
    _validate_image(image)
    checksum = sha256_file(image)
    warnings = []
    if not labels:
        warnings.append("empty_label")
    if any(
        label.width is not None
        and label.height is not None
        and label.width * label.height < 0.0001
        for label in labels
    ):
        warnings.append("tiny_box")
    return ManifestEntryDTO(
        image=image.relative_to(root).as_posix(),
        filename=image.name,
        split=split,
        source_group_id=checksum,
        image_checksum=checksum,
        phash=compute_phash(image),
        labels=labels,
        warnings=tuple(warnings),
    )


def _resolve_yaml_path(yaml_path: Path, data: dict, value: str, extraction_root: Path) -> Path:
    base = Path(data.get("path") or yaml_path.parent)
    if not base.is_absolute():
        base = yaml_path.parent / base
    path = Path(value)
    resolved = path if path.is_absolute() else base / path
    return _require_within(resolved, extraction_root, "YOLO 路径")


def _inspect_yolo(yaml_path: Path, extraction_root: Path) -> DatasetInspectionDTO:
    data = yaml.safe_load(yaml_path.read_text(encoding="utf-8")) or {}
    raw_names = data.get("names")
    if isinstance(raw_names, list):
        names = {index: str(name) for index, name in enumerate(raw_names)}
    elif isinstance(raw_names, dict):
        names = {int(index): str(name) for index, name in raw_names.items()}
    else:
        raise RuntimeError(f"YOLO data.yaml 缺少 names: {yaml_path}")
    entries: list[ManifestEntryDTO] = []
    available_splits = 0
    for split in ("train", "val", "test"):
        value = data.get(split)
        if not isinstance(value, str):
            continue
        image_root = _resolve_yaml_path(yaml_path, data, value, extraction_root)
        if not image_root.is_dir():
            raise RuntimeError(f"YOLO {split} 图片目录不存在: {image_root}")
        available_splits += 1
        for image in _images_under(image_root):
            relative = image.relative_to(image_root)
            parts = list(image_root.parts)
            if "images" in parts:
                reverse_index = parts[::-1].index("images")
                index = len(parts) - reverse_index - 1
                label_root = Path(*parts[:index], "labels", *parts[index + 1 :])
            else:
                label_root = image_root.parent / "labels"
            label_path = (label_root / relative).with_suffix(".txt")
            labels: list[SourceLabelDTO] = []
            if label_path.exists():
                for class_id, xc, yc, width, height in parse_labels(label_path.read_text(encoding="utf-8")):
                    if class_id not in names:
                        raise RuntimeError(f"YOLO 标签引用未知类别 {class_id}: {label_path}")
                    label = SourceLabelDTO(class_id, xc, yc, width, height)
                    _validate_box(label, str(label_path))
                    labels.append(label)
            entries.append(_entry(extraction_root, image, split, tuple(labels)))
    if not entries or available_splits == 0:
        raise RuntimeError(f"YOLO 数据集没有可用图片: {yaml_path}")
    classes = tuple({"class_id": class_id, "name": name} for class_id, name in sorted(names.items()))
    return _finish(
        "yolo_detect",
        extraction_root,
        "detect",
        classes,
        entries,
        split_locked={entry.split for entry in entries} >= {"train", "val"},
    )


def _load_coco_candidate(path: Path) -> dict | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError, OSError):
        return None
    if isinstance(data, dict) and all(key in data for key in ("images", "categories", "annotations")):
        return data
    return None


def _coco_split(path: Path) -> str:
    lower = path.as_posix().lower()
    if "test" in lower:
        return "test"
    if "val" in lower or "valid" in lower:
        return "val"
    return "train"


def _resolve_coco_image(annotation_path: Path, extraction_root: Path, filename: str) -> Path:
    filename_path = Path(filename)
    if filename_path.is_absolute() or ".." in filename_path.parts:
        raise RuntimeError(f"COCO 图片引用包含不安全路径: {filename}")
    candidates = [
        annotation_path.parent / filename,
        annotation_path.parent.parent / filename,
        annotation_path.parent.parent / "images" / filename,
        extraction_root / filename,
    ]
    for candidate in candidates:
        if candidate.is_file():
            return _require_within(candidate, extraction_root, "COCO 图片路径")
    matches = [item for item in extraction_root.rglob(Path(filename).name) if item.is_file()]
    if len(matches) == 1:
        return matches[0]
    raise RuntimeError(f"COCO 图片引用不存在或不唯一: {filename}")


def _inspect_coco(annotation_paths: list[Path], extraction_root: Path) -> DatasetInspectionDTO:
    category_names: dict[int, str] = {}
    entries: list[ManifestEntryDTO] = []
    seen_images: set[tuple[Path, int]] = set()
    for annotation_path in annotation_paths:
        data = _load_coco_candidate(annotation_path)
        if data is None:
            continue
        categories = {int(item["id"]): str(item["name"]) for item in data["categories"]}
        for class_id, name in categories.items():
            existing = category_names.get(class_id)
            if existing is not None and existing != name:
                raise RuntimeError(f"COCO 类别 ID {class_id} 名称冲突: {existing} / {name}")
            category_names[class_id] = name
        annotations: dict[int, list[dict]] = defaultdict(list)
        for annotation in data["annotations"]:
            if annotation.get("iscrowd"):
                continue
            annotations[int(annotation["image_id"])].append(annotation)
        split = _coco_split(annotation_path)
        for image_data in data["images"]:
            image_id = int(image_data["id"])
            identity = (annotation_path, image_id)
            if identity in seen_images:
                continue
            seen_images.add(identity)
            image_path = _resolve_coco_image(annotation_path, extraction_root, str(image_data["file_name"]))
            actual_width, actual_height = _validate_image(image_path)
            width = float(image_data.get("width") or actual_width)
            height = float(image_data.get("height") or actual_height)
            if width <= 0 or height <= 0:
                raise RuntimeError(f"COCO 图片尺寸无效: {image_path}")
            labels: list[SourceLabelDTO] = []
            for annotation in annotations.get(image_id, []):
                category_id = int(annotation["category_id"])
                if category_id not in category_names:
                    raise RuntimeError(f"COCO 标注引用未知类别 {category_id}: {annotation_path}")
                bbox = annotation.get("bbox")
                if not isinstance(bbox, list) or len(bbox) != 4:
                    raise RuntimeError(f"COCO bbox 无效: {annotation_path}")
                x, y, box_width, box_height = (float(value) for value in bbox)
                label = SourceLabelDTO(
                    category_id,
                    (x + box_width / 2) / width,
                    (y + box_height / 2) / height,
                    box_width / width,
                    box_height / height,
                )
                _validate_box(label, str(annotation_path))
                labels.append(label)
            entries.append(_entry(extraction_root, image_path, split, tuple(labels)))
    if not entries:
        raise RuntimeError("COCO 数据集没有可用图片")
    classes = tuple(
        {"class_id": class_id, "name": name} for class_id, name in sorted(category_names.items())
    )
    return _finish(
        "coco_detect",
        extraction_root,
        "detect",
        classes,
        entries,
        split_locked={entry.split for entry in entries} >= {"train", "val"},
    )


def _inspect_classification(root: Path) -> DatasetInspectionDTO:
    split_dirs = {path.name: path for path in root.iterdir() if path.is_dir() and path.name in VALID_SPLITS}
    roots = split_dirs or {"train": root}
    class_names = sorted(
        {
            class_dir.name
            for split_root in roots.values()
            for class_dir in split_root.iterdir()
            if class_dir.is_dir() and _images_under(class_dir)
        }
    )
    if not class_names:
        raise RuntimeError("分类数据集没有包含图片的类别目录")
    class_ids = {name: index for index, name in enumerate(class_names)}
    entries: list[ManifestEntryDTO] = []
    for split, split_root in roots.items():
        for class_name in class_names:
            class_dir = split_root / class_name
            for image in _images_under(class_dir):
                entries.append(
                    _entry(root, image, split, (SourceLabelDTO(class_ids[class_name]),))
                )
    classes = tuple({"class_id": class_ids[name], "name": name} for name in class_names)
    return _finish(
        "classification_folder",
        root,
        "classify",
        classes,
        entries,
        split_locked=set(split_dirs) >= {"train", "val"},
    )


def _finish(
    format_name: str,
    root: Path,
    task_type: str,
    classes: tuple[dict, ...],
    entries: list[ManifestEntryDTO],
    *,
    split_locked: bool,
) -> DatasetInspectionDTO:
    checksums: dict[str, set[str]] = defaultdict(set)
    checksum_counts: Counter[str] = Counter()
    phashes: dict[str, set[str]] = defaultdict(set)
    class_counts: Counter[int] = Counter()
    split_counts: Counter[str] = Counter()
    empty_labels = 0
    small_boxes = 0
    for entry in entries:
        checksums[entry.image_checksum].add(entry.split)
        checksum_counts[entry.image_checksum] += 1
        phashes[entry.phash].add(entry.split)
        split_counts[entry.split] += 1
        if not entry.labels:
            empty_labels += 1
        for label in entry.labels:
            class_counts[label.class_id] += 1
            if label.width is not None and label.height is not None and label.width * label.height < 0.0001:
                small_boxes += 1
    cross_split = sorted(checksum for checksum, splits in checksums.items() if len(splits) > 1)
    near_cross_split = sorted(value for value, splits in phashes.items() if len(splits) > 1)
    blockers = []
    if cross_split:
        blockers.append(f"发现 {len(cross_split)} 组完全相同图片跨 split")
    warnings = []
    if near_cross_split:
        warnings.append(f"发现 {len(near_cross_split)} 组感知哈希相同图片跨 split")
    if empty_labels:
        warnings.append(f"空标签图片 {empty_labels} 张")
    if small_boxes:
        warnings.append(f"极小框 {small_boxes} 个")
    report = {
        "blocking": blockers,
        "warnings": warnings,
        "image_count": len(entries),
        "annotation_count": sum(class_counts.values()),
        "empty_label_count": empty_labels,
        "small_box_count": small_boxes,
        "class_distribution": {str(key): value for key, value in sorted(class_counts.items())},
        "split_distribution": dict(sorted(split_counts.items())),
        "exact_duplicate_groups": sum(1 for count in checksum_counts.values() if count > 1),
        "cross_split_duplicates": len(cross_split),
        "near_cross_split_duplicates": len(near_cross_split),
        "split_locked": split_locked,
    }
    return DatasetInspectionDTO(format_name, root, task_type, classes, tuple(entries), report)


def inspect_dataset(extraction_root: Path, expected_task_type: str) -> DatasetInspectionDTO:
    extraction_root = extraction_root.resolve()
    yaml_candidates = sorted(extraction_root.rglob("data.yaml")) + sorted(extraction_root.rglob("dataset.yaml"))
    if yaml_candidates:
        inspection = _inspect_yolo(yaml_candidates[0], extraction_root)
    else:
        coco_candidates = [path for path in extraction_root.rglob("*.json") if _load_coco_candidate(path)]
        if coco_candidates:
            inspection = _inspect_coco(coco_candidates, extraction_root)
        else:
            roots = [extraction_root]
            children = [path for path in extraction_root.iterdir() if path.is_dir()]
            if len(children) == 1:
                roots.append(children[0])
            last_error: Exception | None = None
            inspection = None
            for root in roots:
                try:
                    inspection = _inspect_classification(root)
                    break
                except RuntimeError as error:
                    last_error = error
            if inspection is None:
                raise RuntimeError("无法识别数据集格式；仅支持 YOLO、COCO 和单标签分类目录") from last_error
    if inspection.task_type != expected_task_type:
        raise RuntimeError(
            f"数据集任务类型为 {inspection.task_type}，与项目 {expected_task_type} 不匹配"
        )
    return inspection
