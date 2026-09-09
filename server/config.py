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


from server.app_config import brand_config, runtime_config

_brand = brand_config()
_runtime = runtime_config()


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=("secrets/dashscope.env", ".env"),
        extra="ignore",
    )

    app_name: str = _brand["fullName"]
    data_dir: Path = Path(__file__).resolve().parent.parent / "data"
    database_url: str = "sqlite:///./data/labelkit.db"
    api_host: str = _runtime["host"]
    api_port: int = int(_runtime["apiPort"])
    cors_origins: list[str] = []
    # 本机 + 任意 IPv4 Origin（含公司网/局域网），便于同事用电脑 IP 访问演示
    cors_origin_regex: str = (
        r"^https?://(?:"
        r"localhost|127\.0\.0\.1|\[::1\]|"
        r"(?:\d{1,3}\.){3}\d{1,3}"
        r")(?::\d+)?$"
    )
    dashscope_api_key: str = ""
    vlm_model: str = "qwen3-vl-plus"
    vlm_base_url: str = "https://dashscope.aliyuncs.com/compatible-mode/v1"
    vlm_max_concurrency: int = 3
    vlm_cost_per_image: float = 0.03
    upload_chunk_bytes: int = 1024 * 1024
    max_upload_bytes: int = 20 * 1024 * 1024 * 1024
    login_username: str = "admin"
    login_password: str = "admin"
    auth_secret: str = "labelkit-local-auth-secret"
    auth_session_hours: int = 12


settings = Settings()
settings.data_dir.mkdir(parents=True, exist_ok=True)
