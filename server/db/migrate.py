"""Fail-fast database migration with a timestamped SQLite backup."""

from __future__ import annotations

import shutil
from datetime import datetime, timezone
from pathlib import Path

from alembic import command
from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import Engine, inspect

from server.db.models import Base


def _alembic_config(engine: Engine) -> Config:
    root = Path(__file__).resolve().parents[2]
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "server" / "db" / "migrations"))
    config.set_main_option("sqlalchemy.url", engine.url.render_as_string(hide_password=False))
    return config


def _backup_database(database_path: Path) -> Path:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S-%f")
    backup = database_path.with_name(f"{database_path.name}.{timestamp}.bak")
    shutil.copy2(database_path, backup)
    return backup


def run_database_migrations(engine: Engine) -> Path | None:
    database_name = engine.url.database
    if not database_name:
        raise RuntimeError("SQLite database path is not configured")
    database_path = Path(database_name).resolve(strict=False)
    database_path.parent.mkdir(parents=True, exist_ok=True)
    config = _alembic_config(engine)

    if not database_path.exists() or database_path.stat().st_size == 0:
        Base.metadata.create_all(bind=engine)
        command.stamp(config, "head")
        return None

    inspector = inspect(engine)
    tables = set(inspector.get_table_names())
    script = ScriptDirectory.from_config(config)
    head = script.get_current_head()
    current = None
    if "alembic_version" in tables:
        with engine.connect() as connection:
            current = MigrationContext.configure(connection).get_current_revision()
    if current == head:
        return None

    backup = _backup_database(database_path)
    if "alembic_version" not in tables:
        command.stamp(config, "0001_baseline")
    command.upgrade(config, "head")
    return backup
