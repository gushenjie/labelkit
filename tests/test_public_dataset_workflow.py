from __future__ import annotations

import json
from pathlib import Path

import cv2
import numpy as np
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from server.core.public_dataset_adapters import license_fingerprint
from server.core.public_dataset_types import PublicDatasetCandidateDTO, SourceLabelDTO
from server.core.public_dataset_workflow import (
    approve_project_public_review_gate,
    evaluate_review,
    publish_import,
    resolve_suggested_mapping,
    suggest_class_mapping,
    trim_oversized_review_sample,
    _dedupe_cross_split_entries,
    _sample_indices,
    review_sample_target,
)
from server.db.models import Base, Category, Frame, FrameStatus, Project
from server.repositories.public_dataset_repository import PublicDatasetRepository


def test_sample_indices_caps_forced_duplicates():
    entries = [
        (index, (SourceLabelDTO(0, 0.5, 0.5, 0.2, 0.2),))
        for index in range(3000)
    ]
    forced = set(range(2800))
    selected = _sample_indices(entries, "import-forced-cap", forced=forced)
    assert len(selected) == review_sample_target(3000)
    assert len(selected) == 60
    assert set(selected) <= forced


def test_trim_oversized_review_sample_demotes_excess(tmp_path, monkeypatch):
    session, repository, record = _prepared_import(tmp_path)
    from server.core import public_dataset_workflow as workflow_module
    from server.repositories import public_dataset_repository as repository_module

    monkeypatch.setattr(workflow_module, "public_imports_dir", lambda _project: tmp_path / "imports")
    monkeypatch.setattr(repository_module, "frames_dir", lambda _project, split: tmp_path / "frames" / split)
    monkeypatch.setattr(
        repository_module,
        "label_path_for_frame",
        lambda _project, frame: tmp_path / "labels" / frame.split / f"{frame.storage_key}.txt",
    )
    updated, created = publish_import(
        repository,
        record.id,
        class_mapping={"5": 0},
        warnings_confirmed=False,
    )
    session.commit()
    # 模拟历史 bug：几乎全部帧被标成抽查
    repository.mark_for_review(list(created))
    repository.update(record.id, review_frame_ids=list(created))
    session.commit()

    trimmed = trim_oversized_review_sample(repository, record.id, maximum=2)
    session.commit()
    assert len(trimmed.review_frame_ids) == 2
    needs_human = session.query(Frame).filter(Frame.status == FrameStatus.NEEDS_HUMAN).count()
    assert needs_human == 2
    auto_ok = session.query(Frame).filter(Frame.status == FrameStatus.AUTO_OK).count()
    assert auto_ok == len(created) - 2



def _session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine)()
    session.add_all(
        [
            Project(id="project", name="P"),
            Category(project_id="project", class_id=0, name="target"),
        ]
    )
    session.commit()
    return session


def _prepared_import(tmp_path: Path, count: int = 4):
    session = _session()
    repository = PublicDatasetRepository(session)
    candidate = PublicDatasetCandidateDTO(
        provider="kaggle",
        source_ref="owner/dataset",
        source_version="1",
        source_url="https://www.kaggle.com/datasets/owner/dataset",
        title="Dataset",
        description="",
        license_name="CC0-1.0",
        license_url="https://www.kaggle.com/datasets/owner/dataset",
        download_bytes=100,
        image_count=count,
        task_type="detect",
    )
    record = repository.create_import(
        "project",
        candidate,
        imports_root=tmp_path / "imports",
        license_confirmed=True,
        task_type="detect",
    )
    record.staging_path.mkdir(parents=True)
    entries = []
    for index in range(count):
        image = record.staging_path / f"image-{index}.jpg"
        assert cv2.imwrite(str(image), np.full((30, 40, 3), index * 20, dtype=np.uint8))
        entries.append(
            {
                "image": image.name,
                "filename": image.name,
                "split": "val" if index == count - 1 else "train",
                "source_group_id": f"group-{index}",
                "image_checksum": f"checksum-{index}",
                "phash": f"phash-{index}",
                "labels": [[5, 0.5, 0.5, 0.4, 0.4]],
                "warnings": [],
            }
        )
    (record.staging_path.parent / "import-manifest.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "format": "yolo_detect",
                "task_type": "detect",
                "classes": [{"class_id": 5, "name": "source-target"}],
                "entries": entries,
            }
        ),
        encoding="utf-8",
    )
    repository.update(
        record.id,
        state="fetched",
        detected_format="yolo_detect",
        source_classes=[{"class_id": 5, "name": "source-target"}],
        quality_report={"blocking": [], "warnings": [], "image_count": count, "annotation_count": count},
    )
    session.commit()
    return session, repository, repository.get_by_id(record.id)


def test_dedupe_cross_split_entries_prefers_train():
    entries = [
        {"image_checksum": "same", "split": "val", "image": "val.jpg"},
        {"image_checksum": "same", "split": "train", "image": "train.jpg"},
        {"image_checksum": "other", "split": "train", "image": "other.jpg"},
    ]
    deduped, removed = _dedupe_cross_split_entries(entries)
    assert removed == 1
    assert len(deduped) == 2
    kept = next(item for item in deduped if item["image_checksum"] == "same")
    assert kept["split"] == "train"


def test_publish_maps_classes_and_creates_reproducible_review_sample(tmp_path, monkeypatch):
    session, repository, record = _prepared_import(tmp_path)
    assert record is not None
    from server.repositories import public_dataset_repository as repository_module
    from server.core import public_dataset_workflow as workflow_module

    monkeypatch.setattr(repository_module, "frames_dir", lambda _project, split: tmp_path / "frames" / split)
    monkeypatch.setattr(workflow_module, "public_imports_dir", lambda _project: tmp_path / "imports")
    monkeypatch.setattr(
        repository_module,
        "label_path_for_frame",
        lambda _project, frame: tmp_path / "labels" / frame.split / f"{frame.storage_key}.txt",
    )

    updated, created = publish_import(
        repository,
        record.id,
        class_mapping={"5": 0},
        warnings_confirmed=False,
    )
    session.commit()

    assert updated.state == "review"
    assert len(created) == 4
    assert len(updated.review_frame_ids) == 4
    frames = session.query(Frame).order_by(Frame.id).all()
    assert all(frame.public_import_id == record.id for frame in frames)
    assert all(frame.annotations[0].class_id == 0 for frame in frames)
    assert {frame.split for frame in frames} == {"train", "val"}

    for frame in frames:
        frame.status = FrameStatus.HUMAN_OK
    session.commit()
    assert evaluate_review(repository, record.id) == ("passed", [])


def test_invalid_mapping_does_not_publish_any_frame(tmp_path):
    session, repository, record = _prepared_import(tmp_path)
    assert record is not None

    with pytest.raises(RuntimeError, match="不存在的类别"):
        publish_import(
            repository,
            record.id,
            class_mapping={"5": 99},
            warnings_confirmed=False,
        )

    assert session.query(Frame).count() == 0
    assert all(record.staging_path.joinpath(f"image-{index}.jpg").exists() for index in range(4))


def test_publish_accepts_worker_publishing_state(tmp_path, monkeypatch):
    session, repository, record = _prepared_import(tmp_path)
    from server.core import public_dataset_workflow as workflow_module
    from server.repositories import public_dataset_repository as repository_module

    monkeypatch.setattr(workflow_module, "public_imports_dir", lambda _project: tmp_path / "imports")
    monkeypatch.setattr(repository_module, "frames_dir", lambda _project, split: tmp_path / "frames" / split)
    monkeypatch.setattr(
        repository_module,
        "label_path_for_frame",
        lambda _project, frame: tmp_path / "labels" / frame.split / f"{frame.storage_key}.txt",
    )
    repository.update(record.id, state="publishing")

    updated, created_ids = publish_import(
        repository,
        record.id,
        class_mapping={"5": 0},
        warnings_confirmed=True,
    )

    assert updated.state == "review"
    assert len(created_ids) == 4
    assert repository.list_for_project("project")[0].id == record.id
    session.close()


def test_publish_cancel_rolls_back_files_and_keeps_staging(tmp_path, monkeypatch):
    session, repository, record = _prepared_import(tmp_path)
    from server.core import public_dataset_workflow as workflow_module
    from server.repositories import public_dataset_repository as repository_module

    monkeypatch.setattr(workflow_module, "public_imports_dir", lambda _project: tmp_path / "imports")
    monkeypatch.setattr(repository_module, "frames_dir", lambda _project, split: tmp_path / "frames" / split)
    monkeypatch.setattr(repository_module, "labels_dir", lambda _project, split: tmp_path / "labels" / split)
    monkeypatch.setattr(
        repository_module,
        "label_path_for_frame",
        lambda _project, frame: tmp_path / "labels" / frame.split / f"{frame.storage_key}.txt",
    )
    checks = 0

    def cancelled():
        nonlocal checks
        checks += 1
        return checks > 5

    with pytest.raises(RuntimeError, match="已取消"):
        publish_import(
            repository,
            record.id,
            class_mapping={"5": 0},
            warnings_confirmed=True,
            cancelled=cancelled,
        )

    assert session.query(Frame).count() == 0
    assert all(record.staging_path.joinpath(f"image-{index}.jpg").exists() for index in range(4))
    assert not list((tmp_path / "frames").rglob("public-*") if (tmp_path / "frames").exists() else [])
    session.close()


def test_suggest_class_mapping_matches_nest_to_bird_nest_alias():
    mapping = suggest_class_mapping(
        ({"class_id": 0, "name": "Nest"},),
        ({"class_id": 0, "name": "鸟窝"},),
    )
    assert mapping == {"0": 0}


def test_suggest_class_mapping_auto_maps_single_source_and_target():
    mapping = suggest_class_mapping(
        ({"class_id": 3, "name": "widget"},),
        ({"class_id": 7, "name": "零件"},),
    )
    assert mapping == {"3": 7}


def test_resolve_suggested_mapping_falls_back_when_llm_returns_null():
    resolved = resolve_suggested_mapping(
        [{"class_id": 0, "name": "Nest"}],
        [{"class_id": 0, "name": "鸟窝"}],
        {"0": None},
    )
    assert resolved == {"0": 0}


def test_publish_rejects_all_ignored_when_dataset_has_labels(tmp_path):
    session, repository, record = _prepared_import(tmp_path)
    repository.update(
        record.id,
        quality_report={
            **record.quality_report,
            "annotation_count": 4,
        },
    )
    with pytest.raises(RuntimeError, match="忽略"):
        publish_import(
            repository,
            record.id,
            class_mapping={"5": None},
            warnings_confirmed=True,
        )
    assert session.query(Frame).count() == 0
    session.close()


def test_approve_project_public_review_gate_accepts_multiple_imports(tmp_path, monkeypatch):
    session, repository, first = _prepared_import(tmp_path, count=3)
    assert first is not None
    from server.core import public_dataset_workflow as workflow_module
    from server.repositories import public_dataset_repository as repository_module

    monkeypatch.setattr(workflow_module, "public_imports_dir", lambda _project: tmp_path / "imports")
    monkeypatch.setattr(repository_module, "frames_dir", lambda _project, split: tmp_path / "frames" / split)
    monkeypatch.setattr(
        repository_module,
        "label_path_for_frame",
        lambda _project, frame: tmp_path / "labels" / frame.split / f"{frame.storage_key}.txt",
    )

    publish_import(repository, first.id, class_mapping={"5": 0}, warnings_confirmed=False)
    second = repository.create_import(
        "project",
        PublicDatasetCandidateDTO(
            provider="kaggle",
            source_ref="owner/other",
            source_version="1",
            source_url="https://www.kaggle.com/datasets/owner/other",
            title="Other",
            description="",
            license_name="CC0-1.0",
            license_url="https://www.kaggle.com/datasets/owner/other",
            download_bytes=100,
            image_count=2,
            task_type="detect",
        ),
        imports_root=tmp_path / "imports",
        license_confirmed=True,
        task_type="detect",
    )
    second.staging_path.mkdir(parents=True)
    entries = []
    for index in range(2):
        image = second.staging_path / f"other-{index}.jpg"
        assert cv2.imwrite(str(image), np.full((30, 40, 3), index * 30, dtype=np.uint8))
        entries.append(
            {
                "image": image.name,
                "filename": image.name,
                "split": "train",
                "source_group_id": f"other-{index}",
                "image_checksum": f"other-checksum-{index}",
                "phash": f"other-phash-{index}",
                "labels": [[5, 0.4, 0.4, 0.3, 0.3]],
                "warnings": [],
            }
        )
    (second.staging_path.parent / "import-manifest.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "format": "yolo_detect",
                "task_type": "detect",
                "classes": [{"class_id": 5, "name": "source-target"}],
                "entries": entries,
            }
        ),
        encoding="utf-8",
    )
    repository.update(
        second.id,
        state="fetched",
        detected_format="yolo_detect",
        source_classes=[{"class_id": 5, "name": "source-target"}],
        quality_report={"blocking": [], "warnings": [], "image_count": 2, "annotation_count": 2},
    )
    publish_import(repository, second.id, class_mapping={"5": 0}, warnings_confirmed=False)
    session.commit()

    for frame in session.query(Frame).all():
        frame.status = FrameStatus.HUMAN_OK
    session.commit()

    passed = approve_project_public_review_gate(repository, "project")
    assert len(passed) == 2
    session.close()
