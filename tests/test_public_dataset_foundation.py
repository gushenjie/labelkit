from __future__ import annotations

import json
import os
import zipfile
from pathlib import Path

import cv2
import numpy as np
import pytest

from server.core.dataset_service import _link_or_copy_immutable
from server.core.public_dataset_archive import inspect_archive, safe_extract
from server.core.public_dataset_inspection import inspect_dataset


def _image(path: Path, value: int = 100) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    assert cv2.imwrite(str(path), np.full((40, 60, 3), value, dtype=np.uint8))


def test_dataset_version_media_uses_hardlink_when_supported(tmp_path):
    source = tmp_path / "source.jpg"
    destination = tmp_path / "snapshot" / "image.jpg"
    source.write_bytes(b"immutable-image")

    _link_or_copy_immutable(source, destination)

    assert destination.read_bytes() == source.read_bytes()
    if os.name == "nt" or source.stat().st_dev == destination.stat().st_dev:
        assert source.stat().st_ino == destination.stat().st_ino


def test_safe_extract_rejects_path_traversal(tmp_path):
    archive = tmp_path / "bad.zip"
    with zipfile.ZipFile(archive, "w") as output:
        output.writestr("../escape.txt", "bad")

    with pytest.raises(RuntimeError, match="不安全路径"):
        inspect_archive(archive)
    assert not (tmp_path / "escape.txt").exists()


def test_yolo_yaml_cannot_escape_extraction_root(tmp_path):
    outside = tmp_path / "outside" / "images" / "train"
    outside.mkdir(parents=True)
    _image(outside / "escape.jpg")
    root = tmp_path / "dataset"
    root.mkdir()
    (root / "data.yaml").write_text(
        "path: ../outside\ntrain: images/train\nnames: [bird]\n",
        encoding="utf-8",
    )

    with pytest.raises(RuntimeError, match="超出数据集解压目录"):
        inspect_dataset(root, "detect")


def test_inspect_yolo_preserves_three_boxes_and_splits(tmp_path):
    for split in ("train", "val"):
        image = tmp_path / "images" / split / f"{split}.jpg"
        _image(image, 40 if split == "train" else 180)
        label = tmp_path / "labels" / split / f"{split}.txt"
        label.parent.mkdir(parents=True, exist_ok=True)
        label.write_text(
            "0 0.2 0.2 0.1 0.1\n0 0.5 0.5 0.2 0.2\n0 0.8 0.8 0.1 0.1\n",
            encoding="utf-8",
        )
    (tmp_path / "data.yaml").write_text(
        "path: .\ntrain: images/train\nval: images/val\nnames:\n  0: target\n",
        encoding="utf-8",
    )

    inspection = inspect_dataset(tmp_path, "detect")

    assert inspection.format == "yolo_detect"
    assert {entry.split for entry in inspection.entries} == {"train", "val"}
    assert all(len(entry.labels) == 3 for entry in inspection.entries)
    assert not inspection.quality_report["blocking"]


def test_inspect_coco_converts_bbox_without_losing_instances(tmp_path):
    image = tmp_path / "images" / "train" / "one.jpg"
    _image(image)
    annotations = tmp_path / "annotations" / "instances_train.json"
    annotations.parent.mkdir(parents=True)
    annotations.write_text(
        json.dumps(
            {
                "images": [{"id": 1, "file_name": "images/train/one.jpg", "width": 60, "height": 40}],
                "categories": [{"id": 7, "name": "target"}],
                "annotations": [
                    {"id": 1, "image_id": 1, "category_id": 7, "bbox": [6, 4, 12, 8]},
                    {"id": 2, "image_id": 1, "category_id": 7, "bbox": [24, 16, 12, 8]},
                    {"id": 3, "image_id": 1, "category_id": 7, "bbox": [42, 28, 12, 8]},
                ],
            }
        ),
        encoding="utf-8",
    )

    inspection = inspect_dataset(tmp_path, "detect")

    assert inspection.format == "coco_detect"
    assert len(inspection.entries) == 1
    assert len(inspection.entries[0].labels) == 3


def test_inspect_classification_directory(tmp_path):
    for split in ("train", "val"):
        for class_name in ("good", "bad"):
            _image(tmp_path / split / class_name / f"{split}-{class_name}.jpg")

    inspection = inspect_dataset(tmp_path, "classify")

    assert inspection.format == "classification_folder"
    assert {item["name"] for item in inspection.classes} == {"good", "bad"}
    assert len(inspection.entries) == 4
