"""读取仓库级统一配置 config/app.json。"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
APP_CONFIG_PATH = REPO_ROOT / "config" / "app.json"


@lru_cache(maxsize=1)
def load_app_config() -> dict[str, Any]:
    return json.loads(APP_CONFIG_PATH.read_text(encoding="utf-8"))


def brand_config() -> dict[str, Any]:
    return load_app_config()["brand"]


def runtime_config() -> dict[str, Any]:
    return load_app_config()["runtime"]
