"""Auto-fix task: re-label failed frames and re-review."""

from __future__ import annotations

from labelkit.config import ProjectConfig
from labelkit.datasets import iter_target_frames
from labelkit.store import FrameStatus, StateStore
from labelkit.tasks.label import run_label
from labelkit.tasks.review import run_review


def run_fix(
    config: ProjectConfig,
    store: StateStore,
    *,
    backend_name: str = "vlm",
    only: str | None = None,
    limit: int = 0,
) -> dict[str, int]:
    max_rounds = config.review_policy.max_fix_rounds
    total_labeled = total_pass = 0

    for round_i in range(max_rounds):
        frames = iter_target_frames(
            config,
            store,
            only=only,
            limit=limit,
            statuses={FrameStatus.NEEDS_HUMAN},
        )
        if not frames:
            break

        label_stats = run_label(
            config, store,
            backend_name=backend_name,
            only=only,
            limit=limit,
            force=True,
        )
        total_labeled += label_stats["ok"]

        for frame in frames:
            rec = store.get(frame.id)
            if rec and rec.status not in (FrameStatus.HUMAN_OK, FrameStatus.AUTO_OK):
                store.update(frame.id, FrameStatus.LLM_LABELED, source=f"fix_round_{round_i + 1}")

        review_stats = run_review(config, store, only=only, limit=limit)
        total_pass += review_stats["pass"]

        remaining = iter_target_frames(
            config, store, only=only, limit=0,
            statuses={FrameStatus.NEEDS_HUMAN},
        )
        if not remaining:
            break

        for frame in remaining:
            rec = store.get(frame.id)
            if rec and rec.status == FrameStatus.AUTO_OK:
                store.update(frame.id, FrameStatus.AUTO_FIXED, source=f"fix_round_{round_i + 1}")

    store.save()
    remaining = len(iter_target_frames(config, store, only=only, statuses={FrameStatus.NEEDS_HUMAN}))
    return {"labeled": total_labeled, "passed_review": total_pass, "remaining": remaining}
