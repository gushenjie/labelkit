"""Settings API."""

from __future__ import annotations

import json
from pathlib import Path

from fastapi import APIRouter

from server.api.schemas import SettingsOut, SettingsUpdate
from server.config import settings

router = APIRouter(prefix="/api/settings", tags=["settings"])

_SETTINGS_FILE = Path(__file__).resolve().parent.parent.parent / "data" / "settings.json"


def _load_persisted() -> dict:
    if _SETTINGS_FILE.exists():
        return json.loads(_SETTINGS_FILE.read_text(encoding="utf-8"))
    return {}


def _save_persisted(data: dict) -> None:
    _SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    _SETTINGS_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def _apply_persisted() -> None:
    data = _load_persisted()
    if data.get("dashscope_api_key"):
        settings.dashscope_api_key = data["dashscope_api_key"]
    if data.get("vlm_model"):
        settings.vlm_model = data["vlm_model"]
    if data.get("vlm_base_url"):
        settings.vlm_base_url = data["vlm_base_url"]
    if data.get("vlm_max_concurrency"):
        settings.vlm_max_concurrency = int(data["vlm_max_concurrency"])
    if data.get("vlm_cost_per_image"):
        settings.vlm_cost_per_image = float(data["vlm_cost_per_image"])


_apply_persisted()


@router.get("", response_model=SettingsOut)
def get_settings():
    return SettingsOut(
        dashscope_api_key_set=bool(settings.dashscope_api_key),
        vlm_model=settings.vlm_model,
        vlm_base_url=settings.vlm_base_url,
        vlm_max_concurrency=settings.vlm_max_concurrency,
        vlm_cost_per_image=settings.vlm_cost_per_image,
    )


@router.put("", response_model=SettingsOut)
def update_settings(body: SettingsUpdate):
    data = _load_persisted()
    if body.dashscope_api_key is not None:
        settings.dashscope_api_key = body.dashscope_api_key
        data["dashscope_api_key"] = body.dashscope_api_key
    if body.vlm_model is not None:
        settings.vlm_model = body.vlm_model
        data["vlm_model"] = body.vlm_model
    if body.vlm_base_url is not None:
        settings.vlm_base_url = body.vlm_base_url
        data["vlm_base_url"] = body.vlm_base_url
    if body.vlm_max_concurrency is not None:
        settings.vlm_max_concurrency = body.vlm_max_concurrency
        data["vlm_max_concurrency"] = body.vlm_max_concurrency
    if body.vlm_cost_per_image is not None:
        settings.vlm_cost_per_image = body.vlm_cost_per_image
        data["vlm_cost_per_image"] = body.vlm_cost_per_image
    _save_persisted(data)
    return get_settings()
