"""Load labelkit.yaml project configuration."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import yaml


@dataclass
class ClassConfig:
    id: int
    name: str
    prompt: str
    color: tuple[int, int, int] = (0, 255, 0)


@dataclass
class VlmConfig:
    base_url: str = "https://dashscope.aliyuncs.com/compatible-mode/v1"
    model: str = "qwen-vl-max"
    api_key_env: str = "DASHSCOPE_API_KEY"
    max_side: int = 1280


@dataclass
class YoloConfig:
    model: str = ""
    conf: float = 0.25
    conf_accept: float = 0.8


@dataclass
class ReviewPolicy:
    max_fix_rounds: int = 2
    human_sample_rate: float = 0.1


@dataclass
class ProjectConfig:
    name: str
    config_path: Path
    root: Path
    task: str
    images_dir: Path
    labels_dir: Path
    state_dir: Path
    classes: list[ClassConfig]
    splits: list[str]
    vlm: VlmConfig
    yolo: YoloConfig
    review_policy: ReviewPolicy
    rules: dict = field(default_factory=dict)

    @property
    def class_names(self) -> dict[int, str]:
        return {c.id: c.name for c in self.classes}

    @property
    def class_colors(self) -> dict[int, tuple[int, int, int]]:
        return {c.id: c.color for c in self.classes}


def _resolve(base: Path, value: str) -> Path:
    p = Path(value)
    return p.resolve() if p.is_absolute() else (base / p).resolve()


def load_config(path: str | Path) -> ProjectConfig:
    config_path = Path(path).resolve()
    base = config_path.parent
    raw = yaml.safe_load(config_path.read_text(encoding="utf-8"))

    classes = [
        ClassConfig(
            id=int(c["id"]),
            name=c["name"],
            prompt=c["prompt"],
            color=tuple(c.get("color", [0, 140, 255] if int(c["id"]) == 0 else [255, 60, 60])),
        )
        for c in raw.get("classes", [])
    ]

    vlm_raw = raw.get("vlm", {})
    yolo_raw = raw.get("yolo", {})
    policy_raw = raw.get("review_policy", {})

    images_dir = _resolve(base, raw["images"])
    labels_dir = _resolve(base, raw["labels"])
    state_dir = _resolve(base, raw.get("state_dir", str(images_dir.parent / ".labelkit")))

    return ProjectConfig(
        name=raw.get("name", config_path.stem),
        config_path=config_path,
        root=base,
        task=raw.get("task", "detect"),
        images_dir=images_dir,
        labels_dir=labels_dir,
        state_dir=state_dir,
        classes=classes,
        splits=raw.get("splits", ["train", "val"]),
        vlm=VlmConfig(
            base_url=vlm_raw.get("base_url", "https://dashscope.aliyuncs.com/compatible-mode/v1"),
            model=vlm_raw.get("model", "qwen-vl-max"),
            api_key_env=vlm_raw.get("api_key_env", "DASHSCOPE_API_KEY"),
            max_side=int(vlm_raw.get("max_side", 1280)),
        ),
        yolo=YoloConfig(
            model=yolo_raw.get("model", ""),
            conf=float(yolo_raw.get("conf", 0.25)),
            conf_accept=float(yolo_raw.get("conf_accept", 0.8)),
        ),
        review_policy=ReviewPolicy(
            max_fix_rounds=int(policy_raw.get("max_fix_rounds", 2)),
            human_sample_rate=float(policy_raw.get("human_sample_rate", 0.1)),
        ),
        rules=raw.get("rules", {}),
    )
