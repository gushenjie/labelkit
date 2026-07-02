"""Geometric validation rules for detect annotations."""

from __future__ import annotations

from dataclasses import dataclass

from labelkit.config import ProjectConfig
from labelkit.yolo_io import yolo_to_xywh


@dataclass
class RuleResult:
    ok: bool
    issues: list[str]


def _get_xywh(labels: dict, cls_id: int, iw: int, ih: int) -> tuple[int, int, int, int] | None:
    if cls_id not in labels:
        return None
    return yolo_to_xywh(*labels[cls_id], iw, ih)


def check_rules(config: ProjectConfig, labels: dict, iw: int, ih: int) -> RuleResult:
    issues: list[str] = []
    rules = config.rules or {}

    bucket = _get_xywh(labels, 0, iw, ih)
    lid = _get_xywh(labels, 1, iw, ih)

    if bucket is None:
        issues.append("missing bucket")
    if lid is None:
        issues.append("missing lid")

    if bucket and lid:
        bx, by, bw, bh = bucket
        lx, ly, lw, lh = lid
        ba = bw * bh
        la = lw * lh

        top_ratio = float(rules.get("lid_top_ratio", 0.40))
        if (ly + lh / 2) > by + bh * top_ratio:
            issues.append(f"lid center below bucket top {int(top_ratio * 100)}%")

        min_area = float(rules.get("lid_area_min", 0.003))
        max_area = float(rules.get("lid_area_max", 0.15))
        ratio = la / max(ba, 1)
        if ratio < min_area:
            issues.append(f"lid too small ({ratio:.3f} < {min_area})")
        if ratio > max_area:
            issues.append(f"lid too large ({ratio:.3f} > {max_area})")

        if lx + lw < bx or lx > bx + bw:
            issues.append("lid horizontally outside bucket")

    return RuleResult(ok=len(issues) == 0, issues=issues)
