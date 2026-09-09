"""Settings API."""

from __future__ import annotations

import json
from pathlib import Path
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from server.api.deps import get_optional_actor
from server.api.schemas import SettingsOut, SettingsUpdate, VlmProfileOut
from server.config import settings
from server.core.audit import record_audit
from server.core.vlm_profiles import (
    VlmProfile,
    ensure_profiles_in_data,
    migrate_profiles,
    profile_from_dict,
    project_default,
    serialize_profiles,
)
from server.db.database import get_db

router = APIRouter(prefix="/api/settings", tags=["settings"])

_SETTINGS_FILE = Path(__file__).resolve().parent.parent.parent / "data" / "settings.json"


def _load_persisted() -> dict:
    if _SETTINGS_FILE.exists():
        return json.loads(_SETTINGS_FILE.read_text(encoding="utf-8"))
    return {}


def _save_persisted(data: dict) -> None:
    _SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    _SETTINGS_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def get_vlm_profiles() -> tuple[list[VlmProfile], str]:
    data = ensure_profiles_in_data(_load_persisted())
    return migrate_profiles(data)


def _apply_persisted() -> None:
    raw = _load_persisted()
    data = ensure_profiles_in_data(raw)
    if data.get("dashscope_api_key"):
        settings.dashscope_api_key = data["dashscope_api_key"]
    if data.get("vlm_max_concurrency"):
        settings.vlm_max_concurrency = int(data["vlm_max_concurrency"])
    profiles, default_id = migrate_profiles(data)
    project_default(settings, profiles, default_id)
    # 启动时写回：兼容迁移 + 补齐推荐预设
    if data.get("vlm_profiles") != raw.get("vlm_profiles") or data.get("default_vlm_id") != raw.get("default_vlm_id"):
        merged = {**raw, **serialize_profiles(profiles, default_id)}
        if "dashscope_api_key" in raw:
            merged["dashscope_api_key"] = raw["dashscope_api_key"]
        if "vlm_max_concurrency" in data:
            merged["vlm_max_concurrency"] = data["vlm_max_concurrency"]
        _save_persisted(merged)


_apply_persisted()


def _settings_out() -> SettingsOut:
    raw = _load_persisted()
    data = ensure_profiles_in_data(raw)
    profiles, default_id = migrate_profiles(data)
    project_default(settings, profiles, default_id)
    # 读接口时若补齐了推荐项，落盘，避免弹框列表落后于代码预设
    if len(data.get("vlm_profiles") or []) != len(raw.get("vlm_profiles") or []) or data.get("default_vlm_id") != raw.get(
        "default_vlm_id"
    ):
        merged = {**raw, **serialize_profiles(profiles, default_id)}
        _save_persisted(merged)
    return SettingsOut(
        dashscope_api_key_set=bool(settings.dashscope_api_key),
        vlm_model=settings.vlm_model,
        vlm_base_url=settings.vlm_base_url,
        vlm_max_concurrency=settings.vlm_max_concurrency,
        vlm_cost_per_image=settings.vlm_cost_per_image,
        vlm_profiles=[VlmProfileOut.model_validate(p.to_dict()) for p in profiles],
        default_vlm_id=default_id,
    )


@router.get("", response_model=SettingsOut)
def get_settings():
    return _settings_out()


@router.put("", response_model=SettingsOut)
def update_settings(
    body: SettingsUpdate,
    db: Session = Depends(get_db),
    actor: str = Depends(get_optional_actor),
):
    data = ensure_profiles_in_data(_load_persisted())
    changed_fields: list[str] = []
    if body.dashscope_api_key is not None:
        settings.dashscope_api_key = body.dashscope_api_key
        data["dashscope_api_key"] = body.dashscope_api_key
        changed_fields.append("dashscope_api_key")
    if body.vlm_max_concurrency is not None:
        settings.vlm_max_concurrency = body.vlm_max_concurrency
        data["vlm_max_concurrency"] = body.vlm_max_concurrency
        changed_fields.append("vlm_max_concurrency")

    profiles, default_id = migrate_profiles(data)

    if body.vlm_profiles is not None:
        next_profiles: list[VlmProfile] = []
        for item in body.vlm_profiles:
            raw = item.model_dump()
            if not raw.get("id"):
                raw["id"] = str(uuid4())
            profile = profile_from_dict(raw)
            if not profile.model:
                raise HTTPException(status_code=400, detail="大模型 model 不能为空")
            next_profiles.append(profile)
        if not next_profiles:
            raise HTTPException(status_code=400, detail="至少保留一个大模型配置")
        profiles = next_profiles
        changed_fields.append("vlm_profiles")

    if body.default_vlm_id is not None:
        default_id = body.default_vlm_id
        changed_fields.append("default_vlm_id")

    # 兼容旧客户端：只改单一字段时同步到默认条目
    if body.vlm_profiles is None and (
        body.vlm_model is not None or body.vlm_base_url is not None or body.vlm_cost_per_image is not None
    ):
        updated: list[VlmProfile] = []
        for profile in profiles:
            if profile.id != default_id:
                updated.append(profile)
                continue
            updated.append(
                VlmProfile(
                    id=profile.id,
                    name=profile.name,
                    model=body.vlm_model if body.vlm_model is not None else profile.model,
                    base_url=body.vlm_base_url if body.vlm_base_url is not None else profile.base_url,
                    cost_per_image=(
                        body.vlm_cost_per_image
                        if body.vlm_cost_per_image is not None
                        else profile.cost_per_image
                    ),
                    enabled=profile.enabled,
                )
            )
            if body.vlm_model is not None:
                changed_fields.append("vlm_model")
            if body.vlm_base_url is not None:
                changed_fields.append("vlm_base_url")
            if body.vlm_cost_per_image is not None:
                changed_fields.append("vlm_cost_per_image")
        profiles = updated

    if not any(p.id == default_id for p in profiles):
        enabled = next((p for p in profiles if p.enabled), None)
        default_id = (enabled or profiles[0]).id

    projected = serialize_profiles(profiles, default_id)
    data.update(projected)
    project_default(settings, profiles, default_id)
    _save_persisted(data)

    if changed_fields:
        metadata = {field: data.get(field) for field in changed_fields if field != "dashscope_api_key"}
        if "dashscope_api_key" in changed_fields:
            metadata["dashscope_api_key"] = "***"
        if "vlm_profiles" in metadata:
            metadata["vlm_profiles"] = f"{len(profiles)} 条"
        record_audit(
            db,
            actor=actor,
            action="settings.update",
            resource_type="settings",
            summary="更新全局设置",
            metadata=metadata,
        )
    return _settings_out()
