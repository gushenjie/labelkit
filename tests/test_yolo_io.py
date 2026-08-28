from __future__ import annotations

from server.core.yolo_io import parse_labels, write_labels
from labelkit.yolo_io import parse_labels as parse_legacy_labels
from labelkit.yolo_io import write_labels as write_legacy_labels


def test_same_class_boxes_survive_round_trip(tmp_path):
    labels = [
        (2, 0.10, 0.20, 0.15, 0.12),
        (2, 0.50, 0.50, 0.20, 0.25),
        (2, 0.85, 0.75, 0.10, 0.18),
    ]
    label_path = tmp_path / "frame.txt"

    write_labels(label_path, labels)

    assert parse_labels(label_path.read_text(encoding="utf-8")) == labels


def test_parser_keeps_repeated_class_rows_in_file_order():
    text = "\n".join(
        [
            "1 0.1 0.2 0.3 0.4",
            "1 0.2 0.3 0.4 0.5",
            "3 0.3 0.4 0.5 0.6",
        ]
    )

    labels = parse_labels(text)

    assert [label[0] for label in labels] == [1, 1, 3]
    assert len(labels) == 3


def test_legacy_cli_keeps_same_class_boxes(tmp_path):
    labels = [
        (4, 0.1, 0.1, 0.2, 0.2),
        (4, 0.5, 0.5, 0.2, 0.2),
        (4, 0.9, 0.9, 0.1, 0.1),
    ]
    path = tmp_path / "legacy.txt"

    write_legacy_labels(path, labels)

    assert parse_legacy_labels(path.read_text(encoding="utf-8")) == labels
