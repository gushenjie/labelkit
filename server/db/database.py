"""Database engine and session."""

from __future__ import annotations

from collections.abc import Generator
from pathlib import Path

from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session, sessionmaker

from server.config import settings


def _sqlite_url() -> str:
    db_path = settings.data_dir / "labelkit.db"
    return f"sqlite:///{db_path}"


engine = create_engine(
    _sqlite_url(),
    connect_args={"check_same_thread": False, "timeout": 30},
    echo=False,
)


@event.listens_for(engine, "connect")
def _set_sqlite_pragma(dbapi_conn, _):
    cursor = dbapi_conn.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA busy_timeout=30000")
    cursor.execute("PRAGMA synchronous=NORMAL")
    cursor.close()


SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def init_db() -> None:
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    from server.db.migrate import run_database_migrations

    run_database_migrations(engine)
    from server.core.user_bootstrap import bootstrap_workspace_users

    with SessionLocal() as db:
        bootstrap_workspace_users(db)


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def project_dir(project_id: str) -> Path:
    path = settings.data_dir / "projects" / project_id
    path.mkdir(parents=True, exist_ok=True)
    return path
