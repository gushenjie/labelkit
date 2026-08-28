from __future__ import annotations

from sqlalchemy import create_engine, inspect, text

from server.db.migrate import run_database_migrations


def test_legacy_database_is_backed_up_and_migration_is_repeatable(tmp_path):
    database_path = tmp_path / "legacy.db"
    engine = create_engine(f"sqlite:///{database_path}")
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE projects (id VARCHAR(36) PRIMARY KEY)"))
        connection.execute(text("CREATE TABLE categories (id VARCHAR(36) PRIMARY KEY)"))
        connection.execute(text("CREATE TABLE videos (id VARCHAR(36) PRIMARY KEY)"))
        connection.execute(text("CREATE TABLE frames (id VARCHAR(36) PRIMARY KEY)"))
        connection.execute(text("CREATE TABLE tasks (id VARCHAR(36) PRIMARY KEY)"))
        connection.execute(text("CREATE TABLE model_versions (id VARCHAR(36) PRIMARY KEY)"))

    backup = run_database_migrations(engine)

    assert backup is not None and backup.exists()
    inspector = inspect(engine)
    assert {"storage_key"} <= {column["name"] for column in inspector.get_columns("videos")}
    assert {"storage_key", "source_group_id"} <= {
        column["name"] for column in inspector.get_columns("frames")
    }
    assert {"cancel_requested", "heartbeat_at", "retry_of_task_id"} <= {
        column["name"] for column in inspector.get_columns("tasks")
    }
    assert run_database_migrations(engine) is None
