from __future__ import annotations

from pathlib import Path

from server.core.train_entry import TrainingRequest, _optional_train_kwargs


def test_optional_train_kwargs_omits_none_and_keeps_set_values():
    request = TrainingRequest(
        mode="detect",
        base_model="yolov8s.pt",
        data=Path("data.yaml"),
        epochs=80,
        imgsz=640,
        batch=8,
        workers=0,
        device="cpu",
        output_root=Path("out"),
        run_name="task_01234567-89ab-cdef-0123-456789abcdef",
        metrics_path=Path("metrics.json"),
        patience=50,
        lr0=0.01,
        optimizer="AdamW",
        seed=0,
        close_mosaic=10,
        weight_decay=None,
        warmup_epochs=None,
    )
    kwargs = _optional_train_kwargs(request)
    assert kwargs == {
        "patience": 50,
        "lr0": 0.01,
        "optimizer": "AdamW",
        "seed": 0,
        "close_mosaic": 10,
    }


def test_training_request_accepts_project_model_path():
    request = TrainingRequest(
        mode="detect",
        base_model=r"D:\models\best.pt",
        data=Path("data.yaml"),
        epochs=10,
        imgsz=640,
        batch=4,
        device="auto",
        output_root=Path("out"),
        run_name="task_01234567-89ab-cdef-0123-456789abcdef",
        metrics_path=Path("metrics.json"),
    )
    assert request.base_model.endswith("best.pt")
    assert _optional_train_kwargs(request) == {}


def test_normalize_workers_caps_on_windows(monkeypatch):
    import sys

    from server.core import train_entry

    monkeypatch.setattr(sys, "platform", "win32")
    assert train_entry._normalize_workers(8) == 2
    assert train_entry._normalize_workers(0) == 0
    monkeypatch.setattr(sys, "platform", "linux")
    assert train_entry._normalize_workers(8) == 8
