"""Project filesystem layout."""

from __future__ import annotations

from pathlib import Path
from typing import Protocol

from server.db.database import project_dir


def videos_dir(project_id: str) -> Path:
    d = project_dir(project_id) / "videos"
    d.mkdir(parents=True, exist_ok=True)
    return d


def frames_dir(project_id: str, split: str = "train") -> Path:
    d = project_dir(project_id) / "frames" / split
    d.mkdir(parents=True, exist_ok=True)
    return d


def labels_dir(project_id: str, split: str = "train") -> Path:
    d = project_dir(project_id) / "labels" / split
    d.mkdir(parents=True, exist_ok=True)
    return d


class StoredFrame(Protocol):
    split: str
    storage_key: str | None
    filepath: str


def label_path_for_frame(project_id: str, frame: StoredFrame) -> Path:
    """Return a collision-safe label path while retaining old-file compatibility."""
    stem = frame.storage_key or Path(frame.filepath).stem
    return labels_dir(project_id, frame.split) / f"{stem}.txt"


def models_dir(project_id: str) -> Path:
    d = project_dir(project_id) / "models"
    d.mkdir(parents=True, exist_ok=True)
    return d


def dataset_versions_dir(project_id: str) -> Path:
    d = project_dir(project_id) / "dataset_versions"
    d.mkdir(parents=True, exist_ok=True)
    return d


def public_imports_dir(project_id: str) -> Path:
    d = project_dir(project_id) / "public_imports"
    d.mkdir(parents=True, exist_ok=True)
    return d


def exports_dir(project_id: str) -> Path:
    d = project_dir(project_id) / "exports"
    d.mkdir(parents=True, exist_ok=True)
    return d


def cache_dir(project_id: str) -> Path:
    d = project_dir(project_id) / "cache"
    d.mkdir(parents=True, exist_ok=True)
    return d
