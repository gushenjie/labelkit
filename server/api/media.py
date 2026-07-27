"""Video and image upload API."""

from __future__ import annotations

from pathlib import Path

import cv2
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy import func
from sqlalchemy.orm import Session

from server.api.schemas import VideoOut
from server.core.dedup import compute_phash
from server.core.paths import frames_dir, videos_dir
from server.db.database import get_db
from server.db.models import Frame, FrameStatus, Project, Video

router = APIRouter(prefix="/api/projects/{project_id}", tags=["media"])

VIDEO_EXTS = {".mp4", ".avi", ".mov", ".mkv"}
IMAGE_EXTS = {".jpg", ".jpeg", ".png"}


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

    ext = Path(file.filename or "").suffix.lower()
    if ext not in VIDEO_EXTS:
        raise HTTPException(400, f"Unsupported video format: {ext}")

    dest_dir = videos_dir(project_id)
    dest = dest_dir / (file.filename or "video.mp4")
    content = await file.read()
    dest.write_bytes(content)

    cap = cv2.VideoCapture(str(dest))
    fps = cap.get(cv2.CAP_PROP_FPS) or None
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    duration = frame_count / fps if fps else None
    cap.release()

    video = Video(
        project_id=project_id,
        filename=dest.name,
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

    dest_dir = frames_dir(project_id, split)
    created = 0
    for file in files:
        ext = Path(file.filename or "").suffix.lower()
        if ext not in IMAGE_EXTS:
            continue
        dest = dest_dir / (file.filename or f"image_{created}.jpg")
        content = await file.read()
        dest.write_bytes(content)
        phash = compute_phash(dest)
        frame = Frame(
            project_id=project_id,
            filename=dest.name,
            filepath=str(dest),
            split=split,
            phash=phash,
            status=FrameStatus.UNLABELED,
            source="upload",
        )
        db.add(frame)
        created += 1

    db.commit()
    return {"uploaded": created}
