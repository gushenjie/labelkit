"""Load local environment variables from .env files (never commit these)."""

from __future__ import annotations

import os
from pathlib import Path

PKG_ROOT = Path(__file__).resolve().parent
REPO_ROOT = PKG_ROOT.parent


def _parse_env_file(path: Path) -> None:
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].strip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key:
            os.environ.setdefault(key, value)


def load_env(config_path: str | Path | None = None) -> list[str]:
    """Load repo .env and optional per-project *.local.env. Returns loaded paths."""
    loaded: list[str] = []
    repo_env = REPO_ROOT / ".env"
    _parse_env_file(repo_env)
    if repo_env.exists():
        loaded.append(str(repo_env))

    if config_path:
        cfg = Path(config_path).resolve()
        local_env = cfg.parent / f"{cfg.stem}.local.env"
        _parse_env_file(local_env)
        if local_env.exists():
            loaded.append(str(local_env))

    return loaded


def api_key_configured(env_name: str = "DASHSCOPE_API_KEY") -> bool:
    return bool(os.environ.get(env_name, "").strip())
