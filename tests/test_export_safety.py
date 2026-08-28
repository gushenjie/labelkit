from __future__ import annotations

from pathlib import Path

import pytest

from server.core.export import EXPORT_MARKER, _resolve_export_target, _validate_existing_target
from server.db.models import Task, TaskType


def _task(output_dir: Path) -> Task:
    return Task(
        id="11111111-1111-1111-1111-111111111111",
        project_id="project",
        task_type=TaskType.EXPORT,
        params={"output_dir": str(output_dir)},
    )


def test_root_directory_cannot_be_export_target():
    root = Path(Path.cwd().anchor)

    with pytest.raises(RuntimeError, match="根目录"):
        _resolve_export_target("project", _task(root))


def test_nonempty_unmarked_directory_cannot_be_overwritten(tmp_path):
    target = tmp_path / "ordinary"
    target.mkdir()
    (target / "keep.txt").write_text("user data", encoding="utf-8")

    with pytest.raises(RuntimeError, match="未带 LabelKit 标记"):
        _validate_existing_target(target, overwrite=True)


def test_marked_directory_requires_explicit_overwrite(tmp_path):
    target = tmp_path / "managed"
    target.mkdir()
    (target / EXPORT_MARKER).write_text("{}", encoding="utf-8")

    with pytest.raises(RuntimeError, match="确认覆盖"):
        _validate_existing_target(target, overwrite=False)

    _validate_existing_target(target, overwrite=True)
