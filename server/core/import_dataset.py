"""Import existing YOLO dataset."""

from __future__ import annotations

import shutil
from collections.abc import Callable
from pathlib import Path

import cv2
from sqlalchemy.orm import Session

from server.core.dedup import compute_phash
from server.core.paths import frames_dir, labels_dir
from server.core.yolo_io import parse_labels
from server.db.models import (
    Annotation,
    Category,
    Frame,
    FrameStatus,
    Project,
    ProjectTaskType,
    Task,
)

_IMG_EXTS = ("*.jpg", "*.jpeg", "*.png")


def _list_images(d: Path) -> list[Path]:
    out: list[Path] = []
    for pat in _IMG_EXTS:
        out += d.glob(pat)
    return sorted(out)


def run_import_classify_task(
    db: Session, task: Task, *, log: Callable[[str], None] | None = None
) -> None:
    """导入 YOLO 分类数据集：root/<split>/<class>/*.jpg 或 root/<class>/*.jpg。

    每张图建 Frame + 分类 Annotation（仅 class_id），状态 needs_human，
    进入「复查标注」队列供人工逐张确认。类别按目录名自动补建。
    """
    project = db.get(Project, task.project_id)
    root = Path(task.params.get("root_dir", ""))
    if not root.exists():
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

    # 类别目录名 -> class_id，缺的自动补建
    cats = db.query(Category).filter(Category.project_id == project.id).all()
    by_name = {c.name: c.class_id for c in cats}
    next_id = max((c.class_id for c in cats), default=-1) + 1
    for cls_name in sorted({e[1] for e in entries}):
        if cls_name not in by_name:
            db.add(Category(project_id=project.id, class_id=next_id, name=cls_name))
            by_name[cls_name] = next_id
            next_id += 1
            if log:
                log(f"自动创建类别: {cls_name} (id={by_name[cls_name]})")
    db.commit()

    existing = {
        f.filename for f in db.query(Frame.filename).filter(Frame.project_id == project.id)
    }
    task.total = len(entries)
    db.commit()
    imported = skipped = 0

    for i, (split, cls_name, img_src) in enumerate(entries):
        if img_src.name in existing:
            skipped += 1
        else:
            dst = frames_dir(project.id, split) / img_src.name
            shutil.copy2(img_src, dst)
            frame = Frame(
                project_id=project.id,
                filename=img_src.name,
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
            existing.add(img_src.name)
            imported += 1

        task.progress = i + 1
        if i % 50 == 0:
            db.commit()

    task.result = {"imported": imported, "skipped": skipped}
    if log:
        log(f"分类数据集导入完成: {imported} 张（跳过重名 {skipped} 张），已置为「待确认」")
    db.commit()


def run_import_task(db: Session, task: Task, *, log: Callable[[str], None] | None = None) -> None:
    project = db.get(Project, task.project_id)
    if project.task_type == ProjectTaskType.CLASSIFY or task.params.get("root_dir"):
        run_import_classify_task(db, task, log=log)
        return

    src_images = Path(task.params.get("images_dir", ""))
    src_labels = Path(task.params.get("labels_dir", ""))
    split = task.params.get("split", "train")

    if not src_images.exists():
        raise RuntimeError(f"Images dir not found: {src_images}")

    dst_frames = frames_dir(project.id, split)
    dst_labels = labels_dir(project.id, split)

    images = sorted(src_images.glob("*.jpg")) + sorted(src_images.glob("*.png"))
    task.total = len(images)
    db.commit()
    imported = 0

    for i, img_src in enumerate(images):
        dst_img = dst_frames / img_src.name
        shutil.copy2(img_src, dst_img)
        phash = compute_phash(dst_img)

        lbl_src = src_labels / f"{img_src.stem}.txt"
        lbl_dst = dst_labels / f"{img_src.stem}.txt"
        if lbl_src.exists():
            shutil.copy2(lbl_src, lbl_dst)

        frame = Frame(
            project_id=project.id,
            filename=img_src.name,
            filepath=str(dst_img),
            split=split,
            phash=phash,
            status=FrameStatus.HUMAN_OK,
            source="import",
        )
        db.add(frame)
        db.flush()

        if lbl_dst.exists():
            labels = parse_labels(lbl_dst.read_text(encoding="utf-8"))
            for cls_id, (xc, yc, w, h) in labels.items():
                db.add(Annotation(
                    frame_id=frame.id, class_id=cls_id,
                    x_center=xc, y_center=yc, width=w, height=h,
                    source="import",
                ))
        else:
            frame.status = FrameStatus.NO_TARGET

        imported += 1
        task.progress = i + 1
        if i % 20 == 0:
            db.commit()

    task.result = {"imported": imported}
    if log:
        log(f"导入完成: {imported} 张")
    db.commit()
