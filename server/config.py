"""Server configuration."""

from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

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


settings = Settings()
settings.data_dir.mkdir(parents=True, exist_ok=True)
