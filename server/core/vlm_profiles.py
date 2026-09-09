"""VLM 配置列表：持久化条目解析与默认投影。"""

from __future__ import annotations

from copy import deepcopy
from dataclasses import asdict, dataclass
from uuid import uuid4

from server.config import settings

DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"
ZHIPU_BASE_URL = "https://open.bigmodel.cn/api/paas/v4"

# 每家只保留一条：面向「图片目标画框预标注」的首选。
# 通义默认用 qwen3-vl-plus：新一代视觉模型，多数账号可直接调用。
BUILTIN_PRESETS: tuple[dict, ...] = (
    {
        "name": "通义 Qwen3-VL Plus",
        "model": "qwen3-vl-plus",
        "base_url": DEFAULT_BASE_URL,
        "cost_per_image": 0.02,
        "enabled": True,
        "vendor": "tongyi",
    },
    {
        "name": "智谱 GLM-4V Plus",
        "model": "glm-4v-plus",
        "base_url": ZHIPU_BASE_URL,
        "cost_per_image": 0.02,
        "enabled": True,
        "vendor": "zhipu",
    },
)

RECOMMENDED_DEFAULT_MODEL = "qwen3-vl-plus"

# 同厂旧款/次优型号：列表精简时自动移除（用户自定义其他 model 会保留）
SUPERSEDED_MODELS = frozenset(
    {
        "qwen2.5-vl-72b-instruct",
        "qwen2.5-vl-7b-instruct",
        "qwen2.5-vl-32b-instruct",
        "qwen-vl-max",
        "qwen-vl-max-latest",
        "qwen-vl-plus",
        "qwen-vl-max-2025-01-25",
        "qwen3-vl-flash",
        "glm-4v",
        "glm-4v-flash",
    }
)


@dataclass(frozen=True)
class VlmProfile:
    id: str
    name: str
    model: str
    base_url: str
    cost_per_image: float
    enabled: bool = True

    def to_dict(self) -> dict:
        return asdict(self)


def _new_id() -> str:
    return str(uuid4())


def profile_from_dict(raw: dict) -> VlmProfile:
    return VlmProfile(
        id=str(raw.get("id") or _new_id()),
        name=str(raw.get("name") or raw.get("model") or "未命名模型").strip() or "未命名模型",
        model=str(raw.get("model") or "").strip(),
        base_url=str(raw.get("base_url") or DEFAULT_BASE_URL).strip().rstrip("/") or DEFAULT_BASE_URL,
        cost_per_image=float(raw.get("cost_per_image", settings.vlm_cost_per_image)),
        enabled=bool(raw.get("enabled", True)),
    )


def _preset_to_profile(preset: dict) -> VlmProfile:
    return VlmProfile(
        id=_new_id(),
        name=str(preset["name"]),
        model=str(preset["model"]),
        base_url=str(preset["base_url"]).rstrip("/"),
        cost_per_image=float(preset["cost_per_image"]),
        enabled=bool(preset.get("enabled", True)),
    )


def prune_superseded_presets(profiles: list[VlmProfile]) -> list[VlmProfile]:
    """去掉同厂次优/旧型号，仅保留每家推荐款与用户自定义型号。"""
    return [profile for profile in profiles if profile.model not in SUPERSEDED_MODELS]


def enrich_with_recommended_presets(profiles: list[VlmProfile]) -> list[VlmProfile]:
    """为已有列表补齐「每家一条」推荐条目（按 model id 去重）。"""
    existing = {profile.model for profile in profiles}
    out = list(profiles)
    for preset in BUILTIN_PRESETS:
        if preset["model"] in existing:
            continue
        out.append(_preset_to_profile(preset))
        existing.add(str(preset["model"]))
    return out


def sync_recommended_labels(profiles: list[VlmProfile]) -> list[VlmProfile]:
    """同步内置推荐项的展示名/单价/启用态，避免残留旧文案。"""
    by_model = {str(preset["model"]): preset for preset in BUILTIN_PRESETS}
    synced: list[VlmProfile] = []
    for profile in profiles:
        preset = by_model.get(profile.model)
        if not preset:
            synced.append(profile)
            continue
        synced.append(
            VlmProfile(
                id=profile.id,
                name=str(preset["name"]),
                model=profile.model,
                base_url=str(preset["base_url"]).rstrip("/"),
                cost_per_image=float(preset["cost_per_image"]),
                enabled=bool(preset.get("enabled", True)),
            )
        )
    return synced


def prefer_recommended_default(profiles: list[VlmProfile], default_id: str) -> str:
    """默认优先落到通义 Qwen3-VL Plus。"""
    recommended = next(
        (profile for profile in profiles if profile.model == RECOMMENDED_DEFAULT_MODEL and profile.enabled),
        None,
    )
    if recommended:
        return recommended.id
    enabled = next((profile for profile in profiles if profile.enabled), None)
    if enabled:
        return enabled.id
    if any(profile.id == default_id for profile in profiles):
        return default_id
    return profiles[0].id


def migrate_profiles(data: dict) -> tuple[list[VlmProfile], str]:
    """从 settings.json 字典得到 profile 列表与默认 id；必要时做兼容迁移。"""
    raw_profiles = data.get("vlm_profiles")
    if isinstance(raw_profiles, list) and raw_profiles:
        profiles = [profile_from_dict(item) for item in raw_profiles if isinstance(item, dict)]
        profiles = [p for p in profiles if p.model]
        if not profiles:
            profiles = _bootstrap_from_legacy(data)
    else:
        profiles = _bootstrap_from_legacy(data)

    profiles = prune_superseded_presets(profiles)
    profiles = enrich_with_recommended_presets(profiles)
    profiles = sync_recommended_labels(profiles)

    default_id = str(data.get("default_vlm_id") or "")
    if not any(p.id == default_id for p in profiles):
        default_id = profiles[0].id
    default_id = prefer_recommended_default(profiles, default_id)
    return profiles, default_id


def _bootstrap_from_legacy(data: dict) -> list[VlmProfile]:
    return [_preset_to_profile(preset) for preset in BUILTIN_PRESETS]


def _display_name_for_model(model: str) -> str:
    for preset in BUILTIN_PRESETS:
        if preset["model"] == model:
            return str(preset["name"])
    return model


def project_default(settings_obj, profiles: list[VlmProfile], default_id: str) -> VlmProfile:
    profile = next((p for p in profiles if p.id == default_id), profiles[0])
    settings_obj.vlm_model = profile.model
    settings_obj.vlm_base_url = profile.base_url
    settings_obj.vlm_cost_per_image = profile.cost_per_image
    return profile


def serialize_profiles(profiles: list[VlmProfile], default_id: str) -> dict:
    return {
        "vlm_profiles": [p.to_dict() for p in profiles],
        "default_vlm_id": default_id,
        "vlm_model": next((p.model for p in profiles if p.id == default_id), profiles[0].model),
        "vlm_base_url": next((p.base_url for p in profiles if p.id == default_id), profiles[0].base_url),
        "vlm_cost_per_image": next(
            (p.cost_per_image for p in profiles if p.id == default_id),
            profiles[0].cost_per_image,
        ),
    }


def resolve_profile(profile_id: str | None = None, *, data: dict | None = None) -> VlmProfile:
    """按 id 解析条目；缺省或无效时回退默认条目。"""
    from pathlib import Path
    import json

    if data is None:
        settings_file = Path(__file__).resolve().parent.parent.parent / "data" / "settings.json"
        if settings_file.exists():
            data = json.loads(settings_file.read_text(encoding="utf-8"))
        else:
            data = {}
    data = ensure_profiles_in_data(data)
    profiles, default_id = migrate_profiles(data)
    if profile_id:
        for profile in profiles:
            if profile.id == profile_id:
                return profile
    for profile in profiles:
        if profile.id == default_id:
            return profile
    return profiles[0]


def ensure_profiles_in_data(data: dict) -> dict:
    """确保 data 含规范化后的 profiles，并投影默认字段。"""
    out = deepcopy(data)
    profiles, default_id = migrate_profiles(out)
    projected = serialize_profiles(profiles, default_id)
    out.update(projected)
    return out
