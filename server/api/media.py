"""Video and image upload API."""

from __future__ import annotations

import shutil
import tempfile
import uuid
from pathlib import Path

import cv2
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import func
from sqlalchemy.orm import Session

from server.api.deps import get_optional_actor
from server.api.schemas import VideoOut
from server.config import settings
from server.core.audit import record_audit
from server.core.dedup import compute_phash
from server.core.image_io import extract_video_thumbnail, open_video_capture, read_image_bgr
from server.core.paths import frames_dir, videos_dir
from server.core.public_dataset_archive import safe_extract
from server.db.database import get_db
from server.db.models import Frame, FrameStatus, Project, Video
from server.worker.task_worker import TaskWorker

router = APIRouter(prefix="/api/projects/{project_id}", tags=["media"])

VIDEO_EXTS = {".mp4", ".avi", ".mov", ".mkv"}
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp"}
ARCHIVE_EXTS = {".zip"}
VALID_SPLITS = {"train", "val", "test"}
MAX_IMAGES_PER_UPLOAD = 10_000
SKIP_ARCHIVE_DIR_NAMES = {"__MACOSX", ".git"}


def _thumbnail_path(video: Video) -> Path:
    return Path(video.filepath).with_suffix(".cover.jpg")


async def _stream_upload(file: UploadFile, destination: Path) -> int:
    written = 0
    try:
        with destination.open("xb") as output:
            while chunk := await file.read(settings.upload_chunk_bytes):
                written += len(chunk)
                if written > settings.max_upload_bytes:
                    raise HTTPException(413, "上传文件超过大小限制")
                output.write(chunk)
    except Exception:
        destination.unlink(missing_ok=True)
        raise
    finally:
        await file.close()
    return written


def _safe_original_name(filename: str | None, fallback: str) -> str:
    return Path(filename or fallback).name


def _validate_split(split: str) -> None:
    if split not in VALID_SPLITS:
        raise HTTPException(400, f"Unsupported split: {split}")


def _video_file_bytes(video: Video) -> int | None:
    if video.file_bytes is not None:
        return video.file_bytes
    path = Path(video.filepath)
    if not path.is_file():
        return None
    return path.stat().st_size


def _build_video_out(video: Video, *, extracted_count: int = 0) -> VideoOut:
    return VideoOut(
        id=video.id,
        filename=video.filename,
        duration_sec=video.duration_sec,
        fps=video.fps,
        frame_count=video.frame_count,
        split=video.split,
        extracted_count=extracted_count,
        file_bytes=_video_file_bytes(video),
        created_at=video.created_at,
    )


def _should_skip_archive_path(relative: Path) -> bool:
    return any(part.startswith(".") or part in SKIP_ARCHIVE_DIR_NAMES for part in relative.parts)


def _collect_images_from_dir(root: Path) -> list[Path]:
    images: list[Path] = []
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        relative = path.relative_to(root)
        if _should_skip_archive_path(relative):
            continue
        if path.suffix.lower() in IMAGE_EXTS:
            images.append(path)
    return images


def _add_frame_from_image(
    *,
    project_id: str,
    original_name: str,
    dest: Path,
    split: str,
    batch_id: str,
    db: Session,
) -> None:
    image = read_image_bgr(dest)
    if image is None or image.size == 0:
        raise HTTPException(400, f"文件内容不是可读取的图片: {original_name}")
    phash = compute_phash(dest)
    frame = Frame(
        project_id=project_id,
        filename=original_name,
        storage_key=dest.stem,
        source_group_id=batch_id,
        filepath=str(dest),
        split=split,
        phash=phash,
        status=FrameStatus.UNLABELED,
        source="upload",
    )
    db.add(frame)


def _ingest_image_path(
    source: Path,
    dest_dir: Path,
    *,
    original_name: str,
    project_id: str,
    split: str,
    batch_id: str,
    db: Session,
    created_paths: list[Path],
) -> None:
    ext = Path(original_name).suffix.lower()
    if ext not in IMAGE_EXTS:
        raise HTTPException(400, f"不支持的图片格式: {ext}")
    storage_key = uuid.uuid4().hex
    dest = dest_dir / f"{storage_key}{ext}"
    shutil.copy2(source, dest)
    created_paths.append(dest)
    _add_frame_from_image(
        project_id=project_id,
        original_name=original_name,
        dest=dest,
        split=split,
        batch_id=batch_id,
        db=db,
    )


async def _ingest_image_upload(
    file: UploadFile,
    dest_dir: Path,
    *,
    project_id: str,
    split: str,
    batch_id: str,
    db: Session,
    created_paths: list[Path],
    index: int,
) -> int:
    original_name = _safe_original_name(file.filename, f"image_{index}.jpg")
    ext = Path(original_name).suffix.lower()
    if ext not in IMAGE_EXTS:
        await file.close()
        raise HTTPException(400, f"不支持的图片格式: {ext}")
    storage_key = uuid.uuid4().hex
    dest = dest_dir / f"{storage_key}{ext}"
    await _stream_upload(file, dest)
    created_paths.append(dest)
    _add_frame_from_image(
        project_id=project_id,
        original_name=original_name,
        dest=dest,
        split=split,
        batch_id=batch_id,
        db=db,
    )
    return 1


async def _ingest_zip_upload(
    file: UploadFile,
    dest_dir: Path,
    *,
    project_id: str,
    split: str,
    batch_id: str,
    db: Session,
    created_paths: list[Path],
) -> int:
    original_name = _safe_original_name(file.filename, "images.zip")
    ext = Path(original_name).suffix.lower()
    if ext not in ARCHIVE_EXTS:
        await file.close()
        raise HTTPException(400, f"不支持的压缩包格式: {ext}")

    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        zip_path = tmp_path / f"upload{ext}"
        await _stream_upload(file, zip_path)
        extract_dir = tmp_path / "extracted"
        safe_extract(zip_path, extract_dir)
        image_paths = _collect_images_from_dir(extract_dir)
        if not image_paths:
            raise HTTPException(400, f"压缩包内未找到支持的图片: {original_name}")
        if len(image_paths) > MAX_IMAGES_PER_UPLOAD:
            raise HTTPException(400, f"压缩包内图片数量超过限制（最多 {MAX_IMAGES_PER_UPLOAD} 张）")
        for image_path in image_paths:
            relative_name = image_path.relative_to(extract_dir).as_posix()
            _ingest_image_path(
                image_path,
                dest_dir,
                original_name=relative_name,
                project_id=project_id,
                split=split,
                batch_id=batch_id,
                db=db,
                created_paths=created_paths,
            )
        return len(image_paths)


@router.get("/videos", response_model=list[VideoOut])
def list_videos(project_id: str, db: Session = Depends(get_db)):
    videos = db.query(Video).filter(Video.project_id == project_id).order_by(Video.created_at.desc()).all()
    counts = dict(
        db.query(Frame.video_id, func.count(Frame.id))
        .filter(Frame.project_id == project_id, Frame.video_id.isnot(None))
        .group_by(Frame.video_id)
        .all()
    )
    return [
        _build_video_out(video, extracted_count=counts.get(video.id, 0))
        for video in videos
    ]


@router.get("/videos/{video_id}/thumbnail")
def video_thumbnail(project_id: str, video_id: str, db: Session = Depends(get_db)):
    """返回视频封面；兼容历史视频，首次访问时按需生成。"""
    video = db.get(Video, video_id)
    if not video or video.project_id != project_id:
        raise HTTPException(404, "Video not found")

    video_path = Path(video.filepath)
    if not video_path.exists():
        raise HTTPException(404, "Video file missing")
    thumbnail = _thumbnail_path(video)
    if not thumbnail.exists():
        try:
            if not extract_video_thumbnail(video_path, thumbnail):
                raise HTTPException(404, "Video thumbnail unavailable")
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(404, "Video thumbnail unavailable") from exc
    return FileResponse(thumbnail, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=86400"})


@router.post("/videos/upload")
async def upload_video(
    project_id: str,
    file: UploadFile = File(...),
    split: str = Form("train"),
    db: Session = Depends(get_db),
    actor: str = Depends(get_optional_actor),
):
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    _validate_split(split)

    original_name = _safe_original_name(file.filename, "video.mp4")
    ext = Path(original_name).suffix.lower()
    if ext not in VIDEO_EXTS:
        raise HTTPException(400, f"Unsupported video format: {ext}")

    dest_dir = videos_dir(project_id)
    storage_key = uuid.uuid4().hex
    dest = dest_dir / f"{storage_key}{ext}"
    written = await _stream_upload(file, dest)

    cap = open_video_capture(dest)
    if not cap.isOpened():
        cap.release()
        dest.unlink(missing_ok=True)
        raise HTTPException(400, "文件内容不是可读取的视频")
    fps = cap.get(cv2.CAP_PROP_FPS) or None
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    duration = frame_count / fps if fps else None
    readable, _ = cap.read()
    cap.release()
    if not readable or frame_count <= 0:
        dest.unlink(missing_ok=True)
        raise HTTPException(400, "视频中没有可读取的帧")

    video = Video(
        project_id=project_id,
        filename=original_name,
        storage_key=storage_key,
        filepath=str(dest),
        fps=fps,
        frame_count=frame_count,
        duration_sec=duration,
        file_bytes=written,
        split=split,
    )
    db.add(video)
    db.commit()
    db.refresh(video)
    try:
        extract_video_thumbnail(dest, _thumbnail_path(video))
    except Exception:
        # 封面仅用于列表预览，不应影响有效视频的上传。
        pass
    record_audit(
        db,
        actor=actor,
        action="media.video.upload",
        resource_type="video",
        resource_id=video.id,
        project_id=project_id,
        summary=f"上传视频：{original_name}",
        metadata={"split": split, "file_bytes": written},
    )
    return _build_video_out(video)


@router.delete("/videos/{video_id}")
def delete_video(project_id: str, video_id: str, db: Session = Depends(get_db), actor: str = Depends(get_optional_actor)):
    video = db.get(Video, video_id)
    if not video or video.project_id != project_id:
        raise HTTPException(404, "视频不存在")

    video_filename = video.filename
    frames = db.query(Frame).filter(Frame.video_id == video_id).all()
    removed_frames = 0
    for frame in frames:
        TaskWorker._delete_frame_artifacts(project_id, frame)
        db.delete(frame)
        removed_frames += 1

    video_path = Path(video.filepath)
    _thumbnail_path(video).unlink(missing_ok=True)
    video_path.unlink(missing_ok=True)
    db.delete(video)
    db.commit()
    record_audit(
        db,
        actor=actor,
        action="media.video.delete",
        resource_type="video",
        resource_id=video_id,
        project_id=project_id,
        summary=f"删除视频：{video_filename}",
        metadata={"removed_frames": removed_frames},
    )
    return {"ok": True, "removed_frames": removed_frames}


@router.post("/images/upload")
async def upload_images(
    project_id: str,
    files: list[UploadFile] = File(...),
    split: str = Form("train"),
    db: Session = Depends(get_db),
    actor: str = Depends(get_optional_actor),
):
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    _validate_split(split)

    dest_dir = frames_dir(project_id, split)
    created = 0
    batch_id = uuid.uuid4().hex
    created_paths: list[Path] = []
    try:
        for index, file in enumerate(files):
            original_name = _safe_original_name(file.filename, f"upload_{index}")
            ext = Path(original_name).suffix.lower()
            if ext in ARCHIVE_EXTS:
                created += await _ingest_zip_upload(
                    file,
                    dest_dir,
                    project_id=project_id,
                    split=split,
                    batch_id=batch_id,
                    db=db,
                    created_paths=created_paths,
                )
            elif ext in IMAGE_EXTS:
                created += await _ingest_image_upload(
                    file,
                    dest_dir,
                    project_id=project_id,
                    split=split,
                    batch_id=batch_id,
                    db=db,
                    created_paths=created_paths,
                    index=created,
                )
            else:
                await file.close()
                raise HTTPException(400, f"不支持的文件格式: {ext}")
    except Exception:
        db.rollback()
        for path in created_paths:
            path.unlink(missing_ok=True)
        raise

    db.commit()
    record_audit(
        db,
        actor=actor,
        action="media.image.upload",
        resource_type="frame",
        project_id=project_id,
        summary=f"上传图片 {created} 张",
        metadata={"split": split, "uploaded": created},
    )
    return {"uploaded": created}
