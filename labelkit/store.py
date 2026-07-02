"""Frame state machine and persistence."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any

from labelkit.config import ProjectConfig


class FrameStatus(str, Enum):
    UNLABELED = "unlabeled"
    LLM_LABELED = "llm_labeled"
    AUTO_OK = "auto_ok"
    AUTO_FIXED = "auto_fixed"
    NEEDS_HUMAN = "needs_human"
    HUMAN_OK = "human_ok"
    HUMAN_WRONG = "human_wrong"


PROTECTED = {FrameStatus.HUMAN_OK}


@dataclass
class FrameRecord:
    id: str
    split: str
    stem: str
    status: FrameStatus = FrameStatus.UNLABELED
    note: str = ""
    review_note: str = ""
    source: str = ""
    history: list[dict[str, Any]] = field(default_factory=list)
    updated_at: str = ""

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "split": self.split,
            "stem": self.stem,
            "status": self.status.value,
            "note": self.note,
            "review_note": self.review_note,
            "source": self.source,
            "history": self.history,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_dict(cls, data: dict) -> FrameRecord:
        return cls(
            id=data["id"],
            split=data["split"],
            stem=data["stem"],
            status=FrameStatus(data.get("status", FrameStatus.UNLABELED.value)),
            note=data.get("note", ""),
            review_note=data.get("review_note", ""),
            source=data.get("source", ""),
            history=data.get("history", []),
            updated_at=data.get("updated_at", ""),
        )


class StateStore:
    def __init__(self, config: ProjectConfig):
        self.config = config
        self.path = config.state_dir / "state.json"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._data = self._load()

    def _load(self) -> dict:
        if self.path.exists():
            return json.loads(self.path.read_text(encoding="utf-8"))
        return {"frames": {}, "meta": {"project": self.config.name}}

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(self._data, ensure_ascii=False, indent=2), encoding="utf-8")

    def get(self, frame_id: str) -> FrameRecord | None:
        raw = self._data.get("frames", {}).get(frame_id)
        return FrameRecord.from_dict(raw) if raw else None

    def get_or_create(self, split: str, stem: str) -> FrameRecord:
        frame_id = f"{split}/{stem}"
        rec = self.get(frame_id)
        if rec:
            return rec
        rec = FrameRecord(id=frame_id, split=split, stem=stem)
        self._data.setdefault("frames", {})[frame_id] = rec.to_dict()
        return rec

    def update(
        self,
        frame_id: str,
        status: FrameStatus,
        *,
        note: str = "",
        review_note: str = "",
        source: str = "",
        extra: dict | None = None,
    ) -> FrameRecord | None:
        rec = self.get(frame_id)
        if not rec:
            return None
        if rec.status in PROTECTED and source != "human":
            return rec

        now = datetime.now(timezone.utc).isoformat()
        entry = {"status": status.value, "source": source, "at": now}
        if note:
            entry["note"] = note
        if review_note:
            entry["review_note"] = review_note
        if extra:
            entry.update(extra)
        rec.history.append(entry)
        rec.status = status
        if note:
            rec.note = note
        if review_note:
            rec.review_note = review_note
        if source:
            rec.source = source
        rec.updated_at = now
        self._data["frames"][frame_id] = rec.to_dict()
        return rec

    def human_update(self, frame_id: str, status: FrameStatus, note: str = "") -> FrameRecord | None:
        if status not in (FrameStatus.HUMAN_OK, FrameStatus.HUMAN_WRONG):
            raise ValueError("human_update only accepts human_ok / human_wrong")
        return self.update(frame_id, status, note=note, source="human")

    def stats(self) -> dict[str, int]:
        counts: dict[str, int] = {s.value: 0 for s in FrameStatus}
        counts["total"] = 0
        for raw in self._data.get("frames", {}).values():
            counts["total"] += 1
            st = raw.get("status", FrameStatus.UNLABELED.value)
            counts[st] = counts.get(st, 0) + 1
        return counts

    def all_records(self) -> list[FrameRecord]:
        return [FrameRecord.from_dict(v) for v in self._data.get("frames", {}).values()]

    def sync_frames(self) -> int:
        """Register all images from config; return new count."""
        added = 0
        for split in self.config.splits:
            img_dir = self.config.images_dir / split
            if not img_dir.exists():
                continue
            for img_path in sorted(img_dir.glob("*.jpg")):
                frame_id = f"{split}/{img_path.stem}"
                if frame_id not in self._data.get("frames", {}):
                    self.get_or_create(split, img_path.stem)
                    added += 1
        if added:
            self.save()
        return added
