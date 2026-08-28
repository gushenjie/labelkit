"""Video and image upload API."""

from __future__ import annotations

import uuid
from pathlib import Path

import cv2
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy import func
from sqlalchemy.orm import Session

from server.api.schemas import VideoOut
from server.config import settings
from server.core.dedup import compute_phash
from server.core.paths import frames_dir, videos_dir
from server.db.database import get_db
from server.db.models import Frame, FrameStatus, Project, Video

router = APIRouter(prefix="/api/projects/{project_id}", tags=["media"])

VIDEO_EXTS = {".mp4", ".avi", ".mov", ".mkv"}
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp"}
VALID_SPLITS = {"train", "val", "test"}


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
        VideoOut(
            id=v.id,
            filename=v.filename,
            duration_sec=v.duration_sec,
            fps=v.fps,
            frame_count=v.frame_count,
            split=v.split,
            extracted_count=counts.get(v.id, 0),
            created_at=v.created_at,
        )
        for v in videos
    ]


@router.post("/videos/upload")
async def upload_video(
    project_id: str,
    file: UploadFile = File(...),
    split: str = Form("train"),
    db: Session = Depends(get_db),
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
    await _stream_upload(file, dest)

    cap = cv2.VideoCapture(str(dest))
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
        split=split,
    )
    db.add(video)
    db.commit()
    db.refresh(video)
    return VideoOut.model_validate(video)


@router.post("/images/upload")
async def upload_images(
    project_id: str,
    files: list[UploadFile] = File(...),
    split: str = Form("train"),
    db: Session = Depends(get_db),
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
        for file in files:
            original_name = _safe_original_name(file.filename, f"image_{created}.jpg")
            ext = Path(original_name).suffix.lower()
            if ext not in IMAGE_EXTS:
                await file.close()
                raise HTTPException(400, f"Unsupported image format: {ext}")
            storage_key = uuid.uuid4().hex
            dest = dest_dir / f"{storage_key}{ext}"
            await _stream_upload(file, dest)
            created_paths.append(dest)
            image = cv2.imread(str(dest))
            if image is None or image.size == 0:
                raise HTTPException(400, f"文件内容不是可读取的图片: {original_name}")
            phash = compute_phash(dest)
            frame = Frame(
                project_id=project_id,
                filename=original_name,
                storage_key=storage_key,
                source_group_id=batch_id,
                filepath=str(dest),
                split=split,
                phash=phash,
                status=FrameStatus.UNLABELED,
                source="upload",
            )
            db.add(frame)
            created += 1
    except Exception:
        db.rollback()
        for path in created_paths:
            path.unlink(missing_ok=True)
        raise

    db.commit()
    return {"uploaded": created}
