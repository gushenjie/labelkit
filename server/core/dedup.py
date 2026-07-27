"""Perceptual hash deduplication."""

from __future__ import annotations

from pathlib import Path

import imagehash
from PIL import Image


def compute_phash(image_path: Path) -> str:
    with Image.open(image_path) as img:
        return str(imagehash.phash(img))


def hamming_distance(h1: str, h2: str) -> int:
    return imagehash.hex_to_hash(h1) - imagehash.hex_to_hash(h2)


def deduplicate_paths(
    paths: list[Path],
    *,
    threshold: int = 8,
) -> tuple[list[Path], list[Path]]:
    """Return (kept, removed) based on phash similarity."""
    kept: list[Path] = []
    removed: list[Path] = []
    hashes: list[str] = []

    for path in paths:
        try:
            h = compute_phash(path)
        except Exception:
            removed.append(path)
            continue
        duplicate = False
        for existing in hashes:
            if hamming_distance(h, existing) <= threshold:
                duplicate = True
                break
        if duplicate:
            removed.append(path)
        else:
            hashes.append(h)
            kept.append(path)
    return kept, removed
