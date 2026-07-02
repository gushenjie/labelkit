"""Dataset frame listing utilities."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from labelkit.config import ProjectConfig
from labelkit.store import FrameRecord, FrameStatus, StateStore
from labelkit.yolo_io import parse_labels


@dataclass
class FrameInfo:
    id: str
    split: str
    stem: str
    image_path: Path
    label_path: Path
    status: FrameStatus
    note: str
    review_note: str
    has_labels: dict[int, bool]

    @property
    def prefix(self) -> str:
        for part in ("ok_front_clear", "ng_front_clear", "ng_front_conveyor_v2", "ng_side_handheld_v2"):
            if self.stem.startswith(part):
                return part
        return self.stem.rsplit("_", 1)[0] if "_" in self.stem else self.stem


def list_frames(
    config: ProjectConfig,
    store: StateStore,
    *,
    split: str | None = None,
    prefix: str | None = None,
    status: FrameStatus | str | None = None,
) -> list[FrameInfo]:
    store.sync_frames()
    splits = [split] if split else config.splits
    out: list[FrameInfo] = []
    for sp in splits:
        img_dir = config.images_dir / sp
        if not img_dir.exists():
            continue
        for img_path in sorted(img_dir.glob("*.jpg")):
            stem = img_path.stem
            if prefix and not stem.startswith(prefix):
                continue
            frame_id = f"{sp}/{stem}"
            rec = store.get_or_create(sp, stem)
            if status and rec.status != (status if isinstance(status, FrameStatus) else FrameStatus(status)):
                continue
            lbl_path = config.labels_dir / sp / f"{stem}.txt"
            labels = parse_labels(lbl_path.read_text()) if lbl_path.exists() else {}
            out.append(
                FrameInfo(
                    id=frame_id,
                    split=sp,
                    stem=stem,
                    image_path=img_path,
                    label_path=lbl_path,
                    status=rec.status,
                    note=rec.note,
                    review_note=rec.review_note,
                    has_labels={c.id: c.id in labels for c in config.classes},
                )
            )
    return out


def iter_target_frames(
    config: ProjectConfig,
    store: StateStore,
    *,
    only: str | None = None,
    limit: int = 0,
    statuses: set[FrameStatus] | None = None,
) -> list[FrameInfo]:
    frames = list_frames(config, store)
    if only:
        frames = [f for f in frames if f.stem.startswith(only)]
    if statuses:
        frames = [f for f in frames if f.status in statuses]
    else:
        frames = [
            f for f in frames
            if f.status not in (FrameStatus.HUMAN_OK, FrameStatus.AUTO_OK)
        ]
    if limit:
        frames = frames[:limit]
    return frames
