from __future__ import annotations

import sys
import sqlite3
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from server.db.models import Base, Category, Frame, FrameStatus, Project


def main() -> None:
    database_url = sys.argv[1]
    image_path = Path(sys.argv[2]).resolve()
    requested_project_id = sys.argv[3] if len(sys.argv) > 3 else ""
    if database_url == "auto":
        for candidate in sorted(
            Path(tempfile.gettempdir()).glob("labelkit-v1-e2e*/**/labelkit.db"),
            key=lambda item: item.stat().st_mtime,
            reverse=True,
        ):
            connection = sqlite3.connect(candidate)
            found = connection.execute(
                "select 1 from projects where id = ?", (requested_project_id,)
            ).fetchone()
            connection.close()
            if found:
                database_url = f"sqlite:///{candidate.as_posix()}"
                break
        else:
            raise RuntimeError(f"Unable to locate E2E database for project {requested_project_id}")
    engine = create_engine(database_url)
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()
    project_id = requested_project_id or str(uuid.uuid4())
    if not requested_project_id:
        db.add(Project(id=project_id, name="v1-10k-browser-benchmark"))
        db.add(Category(project_id=project_id, class_id=0, name="target"))
    now = datetime.now(timezone.utc)
    db.bulk_insert_mappings(
        Frame,
        [
            {
                "id": f"{project_id[:8]}-{index:05d}",
                "project_id": project_id,
                "filename": f"benchmark-{index:05d}.png",
                "storage_key": f"benchmark-{uuid.uuid4().hex}",
                "source_group_id": f"source-{index // 100}",
                "filepath": str(image_path),
                "status": FrameStatus.NEEDS_HUMAN,
                "uncertainty": (index % 1000) / 1000,
                "created_at": now,
                "updated_at": now,
            }
            for index in range(10_000)
        ],
    )
    db.commit()
    print(project_id)


if __name__ == "__main__":
    main()
