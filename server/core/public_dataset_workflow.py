"""Public dataset fetch, publish, and review business workflow."""

from __future__ import annotations

import json
import math
import random
import shutil
from collections import Counter, defaultdict
from collections.abc import Callable
from pathlib import Path

from server.core.public_dataset_adapters import download_public_import, suggest_mapping_with_llm
from server.core.public_dataset_archive import safe_extract
from server.core.public_dataset_inspection import inspect_dataset
from server.core.paths import public_imports_dir
from server.core.public_dataset_types import (
    DatasetInspectionDTO,
    PublicImportDTO,
    PublishFrameDTO,
    SourceLabelDTO,
)
from server.repositories.public_dataset_repository import PublicDatasetRepository


def _manifest_path(import_record: PublicImportDTO) -> Path:
    return import_record.staging_path.parent / "import-manifest.json"


def _write_manifest(import_record: PublicImportDTO, inspection: DatasetInspectionDTO) -> None:
    _manifest_path(import_record).write_text(
        json.dumps(inspection.manifest(), ensure_ascii=False, indent=2), encoding="utf-8"
    )


def _load_manifest(import_record: PublicImportDTO) -> dict:
    path = _manifest_path(import_record)
    if not path.is_file():
        raise RuntimeError("公开数据导入清单不存在，请重新执行下载分析")
    return json.loads(path.read_text(encoding="utf-8"))


def _validated_staging_path(record: PublicImportDTO) -> Path:
    imports_root = public_imports_dir(record.project_id).resolve()
    expected_root = (imports_root / record.id).resolve()
    staging = record.staging_path.resolve()
    if staging.parent != expected_root or imports_root not in expected_root.parents:
        raise RuntimeError("公开数据暂存路径不在当前项目导入目录内")
    return staging


def fetch_and_inspect(
    repository: PublicDatasetRepository,
    import_id: str,
    *,
    cancelled: Callable[[], bool] | None = None,
    log: Callable[[str], None] | None = None,
    progress: Callable[[int, int], None] | None = None,
) -> PublicImportDTO:
    record = repository.get_by_id(import_id)
    if not record:
        raise RuntimeError(f"Public dataset import not found: {import_id}")
    if record.state == "fetched":
        return record
    extracted_dir = _validated_staging_path(record)
    root = extracted_dir.parent
    download_dir = root / "downloads"
    partial_candidates = list(download_dir.glob("*.part")) if download_dir.exists() else []
    complete_archives = [
        path
        for path in download_dir.glob("*")
        if path.is_file() and path.suffix.lower() in {".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz"}
    ] if download_dir.exists() else []
    resume_download = record.state in {"fetch_failed", "fetch_interrupted"} and (
        any(path.stat().st_size > 0 for path in partial_candidates)
        or any(path.stat().st_size > 0 for path in complete_archives)
    )
    if download_dir.exists() and not resume_download:
        shutil.rmtree(download_dir)
    elif not download_dir.exists():
        download_dir.mkdir(parents=True, exist_ok=True)
    if extracted_dir.exists():
        shutil.rmtree(extracted_dir)
    if not download_dir.exists():
        download_dir.mkdir(parents=True)
    extracted_dir.mkdir(parents=True, exist_ok=True)
    repository.update(import_id, state="fetching")
    if log:
        if resume_download:
            log("检测到未完成下载，将从断点续传…")
        else:
            log("正在从公开数据源下载固定版本…")

    def on_download(written: int, expected: int | None) -> None:
        if progress:
            progress(written, expected or 0)

    archives, actual_bytes, checksum = download_public_import(
        record,
        download_dir,
        cancelled=cancelled,
        progress=on_download,
    )
    extracted_bytes = 0
    for archive in archives:
        if cancelled and cancelled():
            raise RuntimeError("任务已取消")
        if archive.suffix.lower() in {".zip", ".tar", ".gz", ".tgz", ".bz2", ".xz"}:
            _, size = safe_extract(archive, extracted_dir)
            extracted_bytes += size
        else:
            destination = extracted_dir / archive.name
            shutil.copy2(archive, destination)
            extracted_bytes += destination.stat().st_size
    task_type = str(record.workflow_metadata.get("task_type") or "")
    inspection = inspect_dataset(extracted_dir, task_type)
    _write_manifest(record, inspection)
    context = repository.project_context(record.project_id)
    llm_mapping = suggest_mapping_with_llm(inspection.classes, context.categories) if context else None
    suggested_mapping = (
        resolve_suggested_mapping(inspection.classes, context.categories, llm_mapping)
        if context
        else {}
    )
    if log:
        log(
            f"识别为 {inspection.format}：{len(inspection.entries)} 张图片，"
            f"{len(inspection.classes)} 个来源类别"
        )
    return repository.update(
        import_id,
        state="fetched",
        actual_download_bytes=actual_bytes,
        extracted_bytes=extracted_bytes,
        artifact_checksum=checksum,
        detected_format=inspection.format,
        detected_root=str(inspection.root.relative_to(extracted_dir)),
        source_classes=list(inspection.classes),
        quality_report=inspection.quality_report,
        workflow_metadata={
            **record.workflow_metadata,
            **({"suggested_mapping": suggested_mapping} if suggested_mapping else {}),
        },
    )


def _normalize_class_token(name: str) -> str:
    return "".join(character for character in str(name).casefold() if character.isalnum())


# 跨语言常见目标检测类别别名，用于 Nest→鸟窝 等场景
_SEMANTIC_CLASS_ALIASES: tuple[frozenset[str], ...] = (
    frozenset({"nest", "birdnest", "birdsnest", "鸟窝", "鸟巢", "niaowo", "niaochao"}),
    frozenset({"person", "human", "pedestrian", "people", "人", "行人", "人体"}),
    frozenset({"helmet", "hardhat", "安全帽", "头盔"}),
    frozenset({"smoke", "fire", "smog", "烟", "烟雾", "火"}),
    frozenset({"car", "vehicle", "automobile", "汽车", "车辆", "小车"}),
)


def _semantic_class_match(source_norm: str, target_norm: str) -> bool:
    if not source_norm or not target_norm:
        return False
    if source_norm == target_norm:
        return True
    if len(source_norm) >= 3 and len(target_norm) >= 3:
        if source_norm in target_norm or target_norm in source_norm:
            return True
    for group in _SEMANTIC_CLASS_ALIASES:
        if source_norm in group and target_norm in group:
            return True
    return False


def suggest_class_mapping(source_classes: tuple[dict, ...], target_categories: tuple[dict, ...]) -> dict[str, int | None]:
    targets = {
        _normalize_class_token(item["name"]): int(item["class_id"])
        for item in target_categories
    }
    mapping: dict[str, int | None] = {}
    for source in source_classes:
        normalized = _normalize_class_token(str(source["name"]))
        matched = targets.get(normalized)
        if matched is None:
            for target_norm, target_id in targets.items():
                if _semantic_class_match(normalized, target_norm):
                    matched = target_id
                    break
        mapping[str(source["class_id"])] = matched
    if (
        len(source_classes) == 1
        and len(target_categories) == 1
        and mapping.get(str(source_classes[0]["class_id"])) is None
    ):
        mapping[str(source_classes[0]["class_id"])] = int(target_categories[0]["class_id"])
    return mapping


def resolve_suggested_mapping(
    source_classes: tuple[dict, ...] | list[dict],
    target_categories: tuple[dict, ...] | list[dict],
    stored: dict[str, int | None] | None = None,
) -> dict[str, int | None]:
    """合并 LLM/历史建议与规则映射，空项回退到语义匹配与单类别默认对应。"""
    sources = tuple(source_classes)
    targets = tuple(target_categories)
    rule_based = suggest_class_mapping(sources, targets)
    stored = stored or {}
    resolved: dict[str, int | None] = {}
    for source in sources:
        key = str(source["class_id"])
        stored_value = stored.get(key) if isinstance(stored, dict) else None
        if stored_value is not None:
            resolved[key] = int(stored_value)
        else:
            resolved[key] = rule_based.get(key)
    return resolved


def _ensure_mapping_preserves_labels(record: PublicImportDTO, class_mapping: dict[str, int | None]) -> None:
    annotation_count = int(record.quality_report.get("annotation_count") or 0)
    if annotation_count <= 0:
        return
    if all(value is None for value in class_mapping.values()):
        raise RuntimeError(
            "数据集含有标注，但所有来源类别均被设为「忽略」。"
            "请至少将一个来源类别映射到项目类别，否则会导入为全部未标注。"
        )


def _sample_indices(
    entries: list[tuple[int, tuple[SourceLabelDTO, ...]]],
    import_id: str,
    maximum: int = 200,
    *,
    splits: dict[int, str] | None = None,
    forced: set[int] | None = None,
) -> list[int]:
    if not entries:
        return []
    target = min(maximum, max(50, math.ceil(len(entries) * 0.02)))
    target = min(target, len(entries))
    buckets: dict[str, list[int]] = defaultdict(list)
    for index, labels in entries:
        for class_id in sorted({label.class_id for label in labels}):
            buckets[f"class:{class_id}"].append(index)
        if splits:
            buckets[f"split:{splits.get(index, 'train')}"].append(index)
    rng = random.Random(import_id)
    for values in buckets.values():
        rng.shuffle(values)
    selected: list[int] = sorted(forced or set())
    seen: set[int] = set(selected)
    while len(selected) < target and buckets:
        progressed = False
        for bucket in sorted(buckets):
            while buckets[bucket] and buckets[bucket][0] in seen:
                buckets[bucket].pop(0)
            if buckets[bucket] and len(selected) < target:
                value = buckets[bucket].pop(0)
                selected.append(value)
                seen.add(value)
                progressed = True
        if not progressed:
            break
    remaining = [index for index, _ in entries if index not in seen]
    rng.shuffle(remaining)
    selected.extend(remaining[: max(0, target - len(selected))])
    return sorted(selected)


def prepare_republish(
    repository: PublicDatasetRepository,
    import_id: str,
    *,
    class_mapping: dict[str, int | None],
) -> PublicImportDTO:
    """清理错误发布结果并回到「待映射发布」，保留已下载的 staging 与 manifest。"""
    record = repository.get_by_id(import_id)
    if not record:
        raise RuntimeError(f"Public dataset import not found: {import_id}")
    if record.dataset_version_id or record.train_task_id:
        raise RuntimeError("该公开数据已进入数据版本或训练，不能重新发布")
    if record.state not in {"needs_label", "publish_interrupted", "review", "review_expanded"}:
        raise RuntimeError(f"当前状态「{record.state}」不支持重新发布")
    context = repository.project_context(record.project_id)
    if not context:
        raise RuntimeError("Project not found")
    resolved_mapping = resolve_suggested_mapping(
        record.source_classes,
        context.categories,
        class_mapping,
    )
    _ensure_mapping_preserves_labels(record, resolved_mapping)
    repository.remove_published_frames(record)
    return repository.update(
        import_id,
        state="fetched",
        class_mapping=resolved_mapping,
        review_frame_ids=[],
        import_task_id=None,
    )


def publish_import(
    repository: PublicDatasetRepository,
    import_id: str,
    *,
    class_mapping: dict[str, int | None],
    warnings_confirmed: bool,
    cancelled: Callable[[], bool] | None = None,
) -> tuple[PublicImportDTO, tuple[str, ...]]:
    record = repository.get_by_id(import_id)
    if not record:
        raise RuntimeError(f"Public dataset import not found: {import_id}")
    if record.state in {"review", "needs_label", "published", "training", "completed"}:
        return record, tuple(frame.id for frame in repository.review_frames(import_id))
    if record.state not in {"fetched", "publishing", "publish_interrupted"}:
        raise RuntimeError("公开数据尚未完成下载分析")
    blocking = list(record.quality_report.get("blocking") or [])
    if blocking:
        raise RuntimeError("质量检查存在阻断项: " + "；".join(blocking))
    if record.quality_report.get("warnings") and not warnings_confirmed:
        raise RuntimeError("请先确认质量报告中的警告")
    source_ids = {str(item["class_id"]) for item in record.source_classes}
    if set(class_mapping) != source_ids:
        missing = sorted(source_ids - set(class_mapping))
        extra = sorted(set(class_mapping) - source_ids)
        raise RuntimeError(f"类别映射不完整或包含未知类别: missing={missing}, extra={extra}")
    context = repository.project_context(record.project_id)
    if not context:
        raise RuntimeError("Project not found")
    target_ids = {int(item["class_id"]) for item in context.categories}
    if any(value is not None and int(value) not in target_ids for value in class_mapping.values()):
        raise RuntimeError("类别映射引用了项目中不存在的类别")
    _ensure_mapping_preserves_labels(record, class_mapping)

    manifest = _load_manifest(record)
    staging_root = _validated_staging_path(record)
    root = (staging_root / (record.detected_root or ".")).resolve()
    if root != staging_root and staging_root not in root.parents:
        raise RuntimeError("数据集根目录超出公开数据暂存区")
    planned: list[tuple[int, PublishFrameDTO]] = []
    labeled_for_sample: list[tuple[int, tuple[SourceLabelDTO, ...]]] = []
    ignored_images = negative_after_mapping = 0
    split_locked = bool(record.quality_report.get("split_locked"))
    for source_index, raw in enumerate(manifest["entries"]):
        if cancelled and cancelled():
            raise RuntimeError("任务已取消")
        labels: list[SourceLabelDTO] = []
        for item in raw.get("labels") or []:
            target = class_mapping[str(int(item[0]))]
            if target is None:
                continue
            labels.append(SourceLabelDTO(int(target), item[1], item[2], item[3], item[4]))
        if context.task_type == "classify" and not labels:
            ignored_images += 1
            continue
        if context.task_type == "detect" and raw.get("labels") and not labels:
            negative_after_mapping += 1
        split = raw.get("split") or "train"
        if split not in {"train", "val", "test"}:
            split = "train"
        original = tuple(label.to_list() for label in labels)
        frame = PublishFrameDTO(
            source_path=root / raw["image"],
            filename=raw["filename"],
            split=split,
            source_group_id=(
                f"public:{record.id}:locked:{raw['image_checksum']}"
                if split_locked
                else f"public:{record.id}:cluster:{raw.get('phash') or raw['image_checksum']}"
            ),
            image_checksum=raw["image_checksum"],
            phash=raw.get("phash") or "",
            labels=tuple(labels),
            status="auto_ok" if labels else "unlabeled",
            original_labels=tuple(tuple(item) for item in original),
        )
        planned.append((source_index, frame))
        if labels:
            labeled_for_sample.append((source_index, tuple(labels)))

    class_groups: dict[int, set[str]] = defaultdict(set)
    class_splits: dict[int, set[str]] = defaultdict(set)
    for _, frame in planned:
        for class_id in {label.class_id for label in frame.labels}:
            class_groups[class_id].add(frame.source_group_id)
            class_splits[class_id].add(frame.split)
    mapped_target_ids = {int(value) for value in class_mapping.values() if value is not None}
    missing_targets = mapped_target_ids - set(class_groups)
    if labeled_for_sample and missing_targets:
        raise RuntimeError(f"映射后类别没有有效标签: {sorted(missing_targets)}")
    if labeled_for_sample and split_locked:
        insufficient = [
            class_id for class_id in sorted(mapped_target_ids)
            if not {"train", "val"} <= class_splits[class_id]
        ]
    elif labeled_for_sample:
        insufficient = [
            class_id for class_id in sorted(mapped_target_ids)
            if len(class_groups[class_id]) < 2
        ]
    else:
        insufficient = []
    if insufficient:
        raise RuntimeError(f"映射后类别无法同时覆盖 train/val 来源: {insufficient}")

    checksum_counts = Counter(str(raw["image_checksum"]) for raw in manifest["entries"])
    phash_counts = Counter(str(raw.get("phash") or "") for raw in manifest["entries"])
    forced_indices = {
        index
        for index, raw in enumerate(manifest["entries"])
        if raw.get("warnings")
        or checksum_counts[str(raw["image_checksum"])] > 1
        or (raw.get("phash") and phash_counts[str(raw["phash"])] > 1)
    }
    sample_source_indices = set(
        _sample_indices(
            labeled_for_sample,
            record.id,
            splits={index: str(raw.get("split") or "train") for index, raw in enumerate(manifest["entries"])},
            forced=forced_indices,
        )
    )
    ordered_frames: list[PublishFrameDTO] = []
    review_originals_by_position: dict[int, list] = {}
    for position, (source_index, frame) in enumerate(planned):
        if source_index in sample_source_indices:
            frame = PublishFrameDTO(**{**frame.__dict__, "status": "needs_human"})
            review_originals_by_position[position] = [list(item) for item in frame.original_labels]
        ordered_frames.append(frame)
    created_ids = repository.publish_frames(
        record,
        tuple(ordered_frames),
        cancelled=cancelled,
    )
    review_ids = [created_ids[position] for position in sorted(review_originals_by_position)]
    review_originals = {
        created_ids[position]: labels for position, labels in review_originals_by_position.items()
    }
    metadata = {
        **record.workflow_metadata,
        "review_round": 1,
        "review_originals": review_originals,
        "ignored_images": ignored_images,
        "negative_after_mapping": negative_after_mapping,
        "published_frame_ids": list(created_ids),
    }
    state = "review" if review_ids else "needs_label"
    updated = repository.update(
        import_id,
        state=state,
        class_mapping=class_mapping,
        review_frame_ids=review_ids,
        workflow_metadata=metadata,
    )
    return updated, created_ids


def finalize_published_import(record: PublicImportDTO) -> None:
    """Remove retry material only after the database publication has committed."""
    staging_root = _validated_staging_path(record)
    if staging_root.exists():
        shutil.rmtree(staging_root)
    downloads = staging_root.parent / "downloads"
    if downloads.exists():
        shutil.rmtree(downloads)


def evaluate_review(repository: PublicDatasetRepository, import_id: str) -> tuple[str, list[str]]:
    record = repository.get_by_id(import_id)
    if not record:
        raise RuntimeError(f"Public dataset import not found: {import_id}")
    if record.state not in {"review", "review_expanded"}:
        raise RuntimeError("公开数据当前不在抽样复查阶段")
    review_ids = set(record.review_frame_ids)
    frames = repository.review_frames(import_id, review_ids)
    if len(frames) != len(review_ids):
        raise RuntimeError("复查样本记录不完整")
    pending = [frame.id for frame in frames if frame.status not in {"human_ok", "no_target"}]
    if pending:
        raise RuntimeError(f"仍有 {len(pending)} 张抽样帧未完成复查")
    originals = record.workflow_metadata.get("review_originals") or {}

    def normalized(labels) -> list[list]:
        return sorted(
            [
                [
                    int(item[0]),
                    *[None if value is None else round(float(value), 6) for value in item[1:]],
                ]
                for item in labels
            ],
            key=lambda item: tuple(-1 if value is None else value for value in item),
        )

    changed = [frame for frame in frames if normalized(frame.labels) != normalized(originals.get(frame.id, []))]
    round_number = int(record.workflow_metadata.get("review_round") or 1)
    if not changed:
        return "passed", []
    if round_number > 1 or len(changed) >= 3:
        repository.update(import_id, state="full_review_required")
        return "full_review_required", [frame.id for frame in changed]

    affected_classes = {class_id for frame in changed for class_id in frame.class_ids}
    all_frames = repository.review_frames(import_id)
    candidates = [
        frame for frame in all_frames
        if frame.id not in review_ids and (not affected_classes or affected_classes.intersection(frame.class_ids))
    ]
    rng = random.Random(f"{record.id}:expanded")
    rng.shuffle(candidates)
    extra = candidates[: min(100, max(1, math.ceil(len(candidates) * 0.1)))]
    extra_ids = [frame.id for frame in extra]
    repository.mark_for_review(extra_ids)
    metadata = {
        **record.workflow_metadata,
        "review_round": 2,
        "review_originals": {
            **originals,
            **{frame.id: [list(item) for item in frame.labels] for frame in extra},
        },
    }
    repository.update(
        import_id,
        state="review_expanded",
        review_frame_ids=[*record.review_frame_ids, *extra_ids],
        workflow_metadata=metadata,
    )
    return "expanded", extra_ids


def prepare_review_after_labeling(
    repository: PublicDatasetRepository, import_id: str
) -> PublicImportDTO:
    record = repository.get_by_id(import_id)
    if not record:
        raise RuntimeError(f"Public dataset import not found: {import_id}")
    frames = repository.review_frames(import_id)
    labeled = [
        (index, tuple(SourceLabelDTO(*label) for label in frame.labels))
        for index, frame in enumerate(frames)
        if frame.labels
    ]
    if not labeled:
        raise RuntimeError("自动标注未产生可复查标签")
    selected_positions = _sample_indices(
        labeled,
        record.id,
        splits={index: frame.split for index, frame in enumerate(frames)},
    )
    selected = [frames[position] for position in selected_positions]
    failures = [frame for frame in frames if not frame.labels]
    selected_ids = list(dict.fromkeys([frame.id for frame in selected] + [frame.id for frame in failures]))
    repository.mark_for_review(selected_ids)
    originals = {
        frame.id: [list(item) for item in frame.labels]
        for frame in [*selected, *failures]
    }
    metadata = {
        **record.workflow_metadata,
        "review_round": 1,
        "review_originals": originals,
    }
    return repository.update(
        import_id,
        state="review",
        review_frame_ids=selected_ids,
        workflow_metadata=metadata,
    )
