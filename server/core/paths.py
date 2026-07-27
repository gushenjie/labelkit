"""Project filesystem layout."""

from __future__ import annotations

from pathlib import Path

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


def models_dir(project_id: str) -> Path:
    d = project_dir(project_id) / "models"
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
