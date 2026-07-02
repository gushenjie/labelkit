"""Export confirmed labels for training."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from labelkit.config import ProjectConfig
from labelkit.datasets import list_frames
from labelkit.store import FrameStatus, StateStore


def run_export(
    config: ProjectConfig,
    store: StateStore,
    out_dir: Path | None = None,
    *,
    include_auto_ok: bool = True,
) -> dict:
    """Copy confirmed frames to export directory and write manifest."""
    export_root = out_dir or (config.state_dir / "export")
    export_root.mkdir(parents=True, exist_ok=True)

    good_statuses = {FrameStatus.HUMAN_OK, FrameStatus.AUTO_FIXED}
    if include_auto_ok:
        good_statuses.add(FrameStatus.AUTO_OK)

    manifest: dict = {"project": config.name, "frames": [], "counts": {}}
    counts = {"exported": 0, "skipped": 0}

    for frame in list_frames(config, store):
        if frame.status not in good_statuses:
            counts["skipped"] += 1
            continue
        if not frame.label_path.exists():
            counts["skipped"] += 1
            continue

        dst_img = export_root / "images" / frame.split / f"{frame.stem}.jpg"
        dst_lbl = export_root / "labels" / frame.split / f"{frame.stem}.txt"
        dst_img.parent.mkdir(parents=True, exist_ok=True)
        dst_lbl.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(frame.image_path, dst_img)
        shutil.copy2(frame.label_path, dst_lbl)
        manifest["frames"].append({"id": frame.id, "status": frame.status.value})
        counts["exported"] += 1

    manifest["counts"] = counts
    manifest_path = export_root / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"export_dir": str(export_root), "manifest": str(manifest_path), **counts}
