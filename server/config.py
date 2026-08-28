"""Server configuration."""

from __future__ import annotations

import os
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parent.parent


def _load_secret_env(path: Path) -> None:
    """Load KEY=VALUE pairs into os.environ without overriding existing values."""
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[7:].strip()
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key:
            os.environ.setdefault(key, value)


# Provider SDKs (Kaggle/Roboflow) read credentials from process env.
_load_secret_env(REPO_ROOT / "secrets" / "dashscope.env")
_load_secret_env(REPO_ROOT / "secrets" / "kaggle.env")
_load_secret_env(REPO_ROOT / "secrets" / "roboflow.env")
_load_secret_env(REPO_ROOT / ".env")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=("secrets/dashscope.env", ".env"),
        extra="ignore",
    )

    app_name: str = "LabelKit"
    data_dir: Path = Path(__file__).resolve().parent.parent / "data"
    database_url: str = "sqlite:///./data/labelkit.db"
    api_host: str = "127.0.0.1"
    api_port: int = 8010
    cors_origins: list[str] = []
    cors_origin_regex: str = r"^https?://(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$"
    dashscope_api_key: str = ""
    vlm_model: str = "qwen-vl-max"
    vlm_base_url: str = "https://dashscope.aliyuncs.com/compatible-mode/v1"
    vlm_max_concurrency: int = 3
    vlm_cost_per_image: float = 0.02
    upload_chunk_bytes: int = 1024 * 1024
    max_upload_bytes: int = 20 * 1024 * 1024 * 1024


settings = Settings()
settings.data_dir.mkdir(parents=True, exist_ok=True)
