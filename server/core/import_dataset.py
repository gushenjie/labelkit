"""Import existing YOLO dataset."""

from __future__ import annotations

import shutil
import hashlib
from collections.abc import Callable
from pathlib import Path

import cv2
from sqlalchemy.orm import Session

from server.core.dedup import compute_phash
from server.core.paths import frames_dir, label_path_for_frame
from server.core.yolo_io import YoloLabel, parse_labels, write_labels
from server.db.models import (
    Annotation,
    Category,
    Frame,
    FrameStatus,
    Project,
    ProjectTaskType,
    Task,
)

_IMG_EXTS = ("*.jpg", "*.jpeg", "*.png", "*.webp")


def _storage_key(project_id: str, image_path: Path) -> str:
    identity = f"{project_id}|{image_path.resolve()}".encode("utf-8")
    return hashlib.sha256(identity).hexdigest()[:32]


def _validate_image(path: Path) -> None:
    image = cv2.imread(str(path))
    if image is None or image.size == 0:
        raise RuntimeError(f"Invalid image: {path}")


def _validate_yolo_labels(
    labels: list[YoloLabel], valid_class_ids: set[int], label_path: Path
) -> None:
    for class_id, xc, yc, width, height in labels:
        if class_id not in valid_class_ids:
            raise RuntimeError(f"Unknown class id {class_id}: {label_path}")
        if not all(0.0 <= value <= 1.0 for value in (xc, yc, width, height)):
            raise RuntimeError(f"YOLO coordinate out of range: {label_path}")
        if width <= 0.0 or height <= 0.0:
            raise RuntimeError(f"YOLO box must have positive size: {label_path}")


def _list_images(d: Path) -> list[Path]:
    out: list[Path] = []
    for pat in _IMG_EXTS:
        out += d.glob(pat)
    return sorted(out)


def run_import_classify_task(
    db: Session,
    task: Task,
    *,
    log: Callable[[str], None] | None = None,
    cancelled: Callable[[], bool] | None = None,
) -> None:
    """导入 YOLO 分类数据集：root/<split>/<class>/*.jpg 或 root/<class>/*.jpg。

    每张图建 Frame + 分类 Annotation（仅 class_id），状态 needs_human，
    进入「复查标注」队列供人工逐张确认。类别按目录名自动补建。
    """
    project = db.get(Project, task.project_id)
    root = Path(task.params.get("root_dir", ""))
    if not root.is_dir():
        raise RuntimeError(f"Dataset root not found: {root}")

    # 收集 (split, class_name, image_path)
    entries: list[tuple[str, str, Path]] = []
    split_dirs = [d for d in root.iterdir() if d.is_dir() and d.name in ("train", "val", "test")]
    if split_dirs:
        for sd in split_dirs:
            split = "val" if sd.name == "test" else sd.name
            for cd in sorted(p for p in sd.iterdir() if p.is_dir()):
                for img in _list_images(cd):
                    entries.append((split, cd.name, img))
    else:
        class_dirs = sorted(p for p in root.iterdir() if p.is_dir())
        if not class_dirs:
            raise RuntimeError(f"No class sub-directories under: {root}")
        for cd in class_dirs:
            for img in _list_images(cd):
                entries.append(("train", cd.name, img))

    if not entries:
        raise RuntimeError("No images found in dataset")
    for _, class_name, image_path in entries:
        if not class_name.strip():
            raise RuntimeError(f"Empty class directory name: {image_path.parent}")
        _validate_image(image_path)

    # 类别目录名 -> class_id，缺的自动补建
    cats = db.query(Category).filter(Category.project_id == project.id).all()
    by_name = {c.name: c.class_id for c in cats}
    next_id = max((c.class_id for c in cats), default=-1) + 1
    created_category_names: list[str] = []
    for cls_name in sorted({e[1] for e in entries}):
        if cls_name not in by_name:
            db.add(Category(project_id=project.id, class_id=next_id, name=cls_name))
            by_name[cls_name] = next_id
            next_id += 1
            created_category_names.append(cls_name)
    db.flush()

    existing = {
        key
        for (key,) in db.query(Frame.storage_key)
        .filter(Frame.project_id == project.id, Frame.storage_key.isnot(None))
        .all()
    }
    import_group_id = hashlib.sha256(str(root.resolve()).encode("utf-8")).hexdigest()[:32]
    task.total = len(entries)
    db.flush()
    imported = skipped = 0
    created_paths: list[Path] = []

    for i, (split, cls_name, img_src) in enumerate(entries):
        if cancelled and cancelled():
            for path in created_paths:
                path.unlink(missing_ok=True)
            raise RuntimeError("任务已取消")
        storage_key = _storage_key(project.id, img_src)
        if storage_key in existing:
            skipped += 1
        else:
            dst = frames_dir(project.id, split) / f"{storage_key}{img_src.suffix.lower()}"
            shutil.copy2(img_src, dst)
            created_paths.append(dst)
            frame = Frame(
                project_id=project.id,
                filename=img_src.name,
                storage_key=storage_key,
                source_group_id=import_group_id,
                filepath=str(dst),
                split=split,
                phash=compute_phash(dst),
                status=FrameStatus.NEEDS_HUMAN,
                note=f"导入标签: {cls_name}",
                source="import",
            )
            db.add(frame)
            db.flush()
            db.add(Annotation(frame_id=frame.id, class_id=by_name[cls_name], source="import"))
            existing.add(storage_key)
            imported += 1

        task.progress = i + 1

    task.result = {"imported": imported, "skipped": skipped}
    if log:
        category_note = f"，新增类别 {len(created_category_names)} 个" if created_category_names else ""
        log(f"分类数据集导入完成: {imported} 张（跳过重名 {skipped} 张{category_note}），已置为「待确认」")
    db.commit()


def run_import_task(
    db: Session,
    task: Task,
    *,
    log: Callable[[str], None] | None = None,
    cancelled: Callable[[], bool] | None = None,
) -> None:
    project = db.get(Project, task.project_id)
    if project.task_type == ProjectTaskType.CLASSIFY or task.params.get("root_dir"):
        run_import_classify_task(db, task, log=log, cancelled=cancelled)
        return

    src_images = Path(task.params.get("images_dir", ""))
    src_labels = Path(task.params.get("labels_dir", ""))
    split = task.params.get("split", "train")

    if not src_images.is_dir():
        raise RuntimeError(f"Images dir not found: {src_images}")
    if not src_labels.is_dir():
        raise RuntimeError(f"Labels dir not found: {src_labels}")

    dst_frames = frames_dir(project.id, split)
    images = _list_images(src_images)
    if not images:
        raise RuntimeError(f"No images found in: {src_images}")
    valid_class_ids = {
        class_id
        for (class_id,) in db.query(Category.class_id)
        .filter(Category.project_id == project.id)
        .all()
    }
    validated: list[tuple[Path, list[YoloLabel]]] = []
    for image_path in images:
        _validate_image(image_path)
        label_path = src_labels / f"{image_path.stem}.txt"
        labels = parse_labels(label_path.read_text(encoding="utf-8")) if label_path.exists() else []
        _validate_yolo_labels(labels, valid_class_ids, label_path)
        validated.append((image_path, labels))

    existing = {
        key
        for (key,) in db.query(Frame.storage_key)
        .filter(Frame.project_id == project.id, Frame.storage_key.isnot(None))
        .all()
    }
    import_group_id = hashlib.sha256(str(src_images.resolve()).encode("utf-8")).hexdigest()[:32]
    task.total = len(images)
    db.flush()
    imported = skipped = 0
    created_frames: list[Frame] = []

    for i, (img_src, labels) in enumerate(validated):
        if cancelled and cancelled():
            for created_frame in created_frames:
                Path(created_frame.filepath).unlink(missing_ok=True)
                label_path_for_frame(project.id, created_frame).unlink(missing_ok=True)
            raise RuntimeError("任务已取消")
        storage_key = _storage_key(project.id, img_src)
        if storage_key in existing:
            skipped += 1
            task.progress = i + 1
            continue
        dst_img = dst_frames / f"{storage_key}{img_src.suffix.lower()}"
        shutil.copy2(img_src, dst_img)
        phash = compute_phash(dst_img)

        frame = Frame(
            project_id=project.id,
            filename=img_src.name,
            storage_key=storage_key,
            source_group_id=import_group_id,
            filepath=str(dst_img),
            split=split,
            phash=phash,
            status=FrameStatus.HUMAN_OK,
            source="import",
        )
        db.add(frame)
        db.flush()
        created_frames.append(frame)

        if labels:
            write_labels(label_path_for_frame(project.id, frame), labels)
            for cls_id, xc, yc, w, h in labels:
                db.add(Annotation(
                    frame_id=frame.id, class_id=cls_id,
                    x_center=xc, y_center=yc, width=w, height=h,
                    source="import",
                ))
        else:
            frame.status = FrameStatus.NO_TARGET

        imported += 1
        existing.add(storage_key)
        task.progress = i + 1

    task.result = {"imported": imported, "skipped": skipped}
    if log:
        log(f"导入完成: {imported} 张（幂等跳过 {skipped} 张）")
    db.commit()
