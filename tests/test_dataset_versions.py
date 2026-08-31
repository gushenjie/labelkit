from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from server.core import dataset_service as dataset_module
from server.core.dataset_service import DatasetService, DatasetVersionRepository
from server.db.models import (
    Annotation,
    Base,
    Category,
    Frame,
    FrameStatus,
    Project,
    ProjectTaskType,
)


def _write_image(path: Path, value: int) -> None:
    assert cv2.imwrite(str(path), np.full((24, 32, 3), value, dtype=np.uint8))


def test_detection_version_keeps_source_group_in_one_split_and_reproduces_labels(tmp_path, monkeypatch):
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    project = Project(id="project", name="P", task_type=ProjectTaskType.DETECT)
    session.add_all([project, Category(project_id=project.id, class_id=0, name="target")])
    for index, group in enumerate(["video-a", "video-a", "video-b", "video-b"]):
        image_path = tmp_path / f"source-{index}.jpg"
        _write_image(image_path, index * 40)
        frame = Frame(
            id=f"frame-{index}",
            project_id=project.id,
            filename=image_path.name,
            filepath=str(image_path),
            source_group_id=group,
            status=FrameStatus.HUMAN_OK,
        )
        session.add(frame)
        session.flush()
        session.add_all(
            [
                Annotation(frame_id=frame.id, class_id=0, x_center=0.2, y_center=0.2, width=0.1, height=0.1),
                Annotation(frame_id=frame.id, class_id=0, x_center=0.7, y_center=0.7, width=0.2, height=0.2),
            ]
        )
    session.commit()
    monkeypatch.setattr(dataset_module, "dataset_versions_dir", lambda _project_id: tmp_path / "versions")
    service = DatasetService(DatasetVersionRepository(session))

    version = service.create_version(project.id, project.task_type)
    session.commit()
    group_splits: dict[str, set[str]] = {}
    for entry in version.manifest["frames"]:
        group_splits.setdefault(entry["source_group_id"], set()).add(entry["split"])
    assert all(len(splits) == 1 for splits in group_splits.values())

    first = tmp_path / "materialized-a"
    second = tmp_path / "materialized-b"
    assert service.materialize(version, first) == service.materialize(version, second)
    first_labels = sorted(path.read_text(encoding="utf-8") for path in first.rglob("*.txt"))
    second_labels = sorted(path.read_text(encoding="utf-8") for path in second.rglob("*.txt"))
    assert first_labels == second_labels
    assert all(len([line for line in text.splitlines() if line]) == 2 for text in first_labels)


def test_detection_single_source_group_falls_back_to_frame_split(tmp_path, monkeypatch):
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    project = Project(id="project", name="P", task_type=ProjectTaskType.DETECT)
    session.add_all([project, Category(project_id=project.id, class_id=0, name="flame")])
    for index in range(5):
        image_path = tmp_path / f"frame-{index}.jpg"
        _write_image(image_path, index * 50)
        frame = Frame(
            id=f"frame-{index}",
            project_id=project.id,
            filename=image_path.name,
            filepath=str(image_path),
            source_group_id="single-video",
            status=FrameStatus.HUMAN_OK,
        )
        session.add(frame)
        session.flush()
        session.add(
            Annotation(
                frame_id=frame.id,
                class_id=0,
                x_center=0.5,
                y_center=0.5,
                width=0.2,
                height=0.2,
            )
        )
    session.commit()
    monkeypatch.setattr(dataset_module, "dataset_versions_dir", lambda _project_id: tmp_path / "versions")
    service = DatasetService(DatasetVersionRepository(session))

    version = service.create_version(project.id, project.task_type, val_ratio=0.2)

    splits = {entry["split"] for entry in version.manifest["frames"]}
    assert splits == {"train", "val"}
    assert len(version.manifest["frames"]) == 5


def test_classification_split_covers_each_class_and_excludes_no_target(tmp_path, monkeypatch):
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    project = Project(id="project", name="P", task_type=ProjectTaskType.CLASSIFY)
    session.add_all(
        [
            project,
            Category(project_id=project.id, class_id=0, name="good"),
            Category(project_id=project.id, class_id=1, name="bad"),
        ]
    )
    index = 0
    for class_id in (0, 1):
        for group_suffix in ("a", "b"):
            image_path = tmp_path / f"class-{class_id}-{group_suffix}.jpg"
            _write_image(image_path, 40 + index * 30)
            frame = Frame(
                project_id=project.id,
                filename=image_path.name,
                filepath=str(image_path),
                source_group_id=f"class-{class_id}-{group_suffix}",
                status=FrameStatus.HUMAN_OK,
            )
            session.add(frame)
            session.flush()
            session.add(Annotation(frame_id=frame.id, class_id=class_id))
            index += 1
    negative_path = tmp_path / "negative.jpg"
    _write_image(negative_path, 0)
    session.add(
        Frame(
            project_id=project.id,
            filename=negative_path.name,
            filepath=str(negative_path),
            source_group_id="negative",
            status=FrameStatus.NO_TARGET,
        )
    )
    session.commit()
    monkeypatch.setattr(dataset_module, "dataset_versions_dir", lambda _project_id: tmp_path / "versions")

    version = DatasetService(DatasetVersionRepository(session)).create_version(project.id, project.task_type)

    class_splits: dict[int, set[str]] = {}
    for entry in version.manifest["frames"]:
        class_splits.setdefault(int(entry["labels"][0][0]), set()).add(entry["split"])
    assert class_splits == {0: {"train", "val"}, 1: {"train", "val"}}
    assert len(version.manifest["frames"]) == 4
