"""训练参数建议：启发式、硬件画像、clamp、无 Key 降级。"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from server.core import suggest_train_params as module
from server.core.suggest_train_params import (
    HardwareProfile,
    _SuggestContext,
    build_heuristic_suggestion,
    clamp_suggested_params,
    estimate_batch_for_hardware,
    refine_with_llm,
    suggest_train_params,
)


def _hw(**overrides) -> HardwareProfile:
    base = dict(
        accelerator="cpu",
        gpu_name="",
        vram_gb=None,
        vram_free_gb=None,
        cpu_cores=8,
        ram_gb=16.0,
        ram_available_gb=12.0,
        ram_used_percent=30.0,
    )
    base.update(overrides)
    return HardwareProfile(**base)


def _context(**overrides) -> _SuggestContext:
    base = dict(
        project_name="鸟巢检测",
        task_type="detect",
        categories=({"name": "bird nest", "description": "杆塔鸟巢"},),
        sample_count=1000,
        train_count=800,
        val_count=200,
        test_count=0,
        class_count=1,
        allowed_base_models=(
            "yolov8n.pt",
            "yolov8s.pt",
            "yolov8m.pt",
            "yolov8l.pt",
            "yolo11n.pt",
            "yolo11s.pt",
        ),
        latest_project_model=None,
        small_object_likely=True,
        hardware=_hw(),
    )
    base.update(overrides)
    return _SuggestContext(**base)


def test_heuristic_small_sample_prefers_light_model():
    params, reason = build_heuristic_suggestion(_context(sample_count=200, small_object_likely=False))
    assert params.base_model == "yolov8n.pt"
    assert params.epochs >= 100
    assert params.batch <= 8
    assert "样本约 200" in reason


def test_heuristic_large_sample_prefers_medium_model():
    params, reason = build_heuristic_suggestion(
        _context(
            sample_count=12000,
            small_object_likely=False,
            categories=({"name": "person", "description": ""},),
            hardware=_hw(accelerator="cuda", gpu_name="RTX 5070 Ti", vram_gb=16.0, vram_free_gb=14.0, cpu_cores=16, ram_available_gb=40.0),
        )
    )
    assert params.base_model == "yolov8m.pt"
    assert 40 <= params.epochs <= 80
    assert params.batch >= 16
    assert "yolov8m.pt" in reason
    assert "显存" in reason or "5070" in reason or "可用" in reason


def test_heuristic_continues_from_project_weight_with_lower_lr():
    params, reason = build_heuristic_suggestion(
        _context(
            sample_count=3000,
            latest_project_model=r"D:\data\models\best.pt",
            allowed_base_models=(
                "yolov8s.pt",
                r"D:\data\models\best.pt",
            ),
        )
    )
    assert params.base_model == r"D:\data\models\best.pt"
    assert params.lr0 == pytest.approx(0.001)
    assert params.epochs <= 60
    assert "继续微调" in reason


def test_estimate_batch_scales_with_vram():
    low = estimate_batch_for_hardware(
        _hw(accelerator="cuda", vram_gb=6.0, vram_free_gb=5.5, cpu_cores=8, ram_available_gb=30.0),
        size_key="s",
        imgsz=640,
    )
    high = estimate_batch_for_hardware(
        _hw(
            accelerator="cuda",
            vram_gb=16.0,
            vram_free_gb=14.0,
            cpu_cores=16,
            ram_available_gb=40.0,
            ram_used_percent=30.0,
        ),
        size_key="s",
        imgsz=640,
    )
    assert high > low
    assert high >= 24


def test_estimate_batch_shrinks_when_system_ram_tight():
    tight = estimate_batch_for_hardware(
        _hw(
            accelerator="cuda",
            gpu_name="RTX 5070 Ti",
            vram_gb=16.0,
            vram_free_gb=14.0,
            cpu_cores=16,
            ram_gb=64.0,
            ram_available_gb=6.0,
            ram_used_percent=90.0,
        ),
        size_key="m",
        imgsz=640,
    )
    loose = estimate_batch_for_hardware(
        _hw(
            accelerator="cuda",
            gpu_name="RTX 5070 Ti",
            vram_gb=16.0,
            vram_free_gb=14.0,
            cpu_cores=16,
            ram_gb=64.0,
            ram_available_gb=40.0,
            ram_used_percent=30.0,
        ),
        size_key="m",
        imgsz=640,
    )
    assert tight <= 8
    assert loose > tight


def test_heuristic_uses_more_batch_on_high_vram_gpu():
    params, reason = build_heuristic_suggestion(
        _context(
            sample_count=9000,
            small_object_likely=True,
            hardware=_hw(
                accelerator="cuda",
                gpu_name="NVIDIA GeForce RTX 5070 Ti",
                vram_gb=16.0,
                vram_free_gb=14.0,
                cpu_cores=16,
                ram_gb=64.0,
                ram_available_gb=40.0,
                ram_used_percent=30.0,
            ),
        )
    )
    assert params.batch >= 16
    assert params.workers >= 0
    assert "可用" in reason or "显存" in reason or "RTX" in reason

    cpu_params, _ = build_heuristic_suggestion(
        _context(sample_count=9000, small_object_likely=True, hardware=_hw()),
    )
    assert params.batch > cpu_params.batch


def test_clamp_rejects_unknown_base_model_and_out_of_range_values():
    context = _context(
        hardware=_hw(
            accelerator="cuda",
            gpu_name="RTX",
            vram_gb=16.0,
            vram_free_gb=14.0,
            cpu_cores=16,
            ram_available_gb=40.0,
            ram_used_percent=30.0,
        ),
    )
    baseline, _ = build_heuristic_suggestion(context)
    clamped = clamp_suggested_params(
        {
            "epochs": 9999,
            "imgsz": 641,
            "batch": 128,
            "base_model": "not-a-real-model.pt",
            "workers": 99,
            "patience": 5000,
            "lr0": 9.9,
            "optimizer": "rmsprop",
            "seed": -1,
            "close_mosaic": 999,
            "weight_decay": 1.0,
            "warmup_epochs": 99,
        },
        context,
        baseline,
    )
    assert clamped.epochs == 1000
    assert clamped.imgsz % 32 == 0
    assert 320 <= clamped.imgsz <= 1280
    assert clamped.batch == 48
    assert clamped.base_model == baseline.base_model
    assert clamped.workers == 2
    assert clamped.patience == clamped.epochs
    assert clamped.lr0 == pytest.approx(0.1)
    assert clamped.optimizer == baseline.optimizer
    assert clamped.seed == 0
    assert clamped.close_mosaic == 999
    assert clamped.weight_decay == pytest.approx(0.01)
    assert clamped.warmup_epochs == pytest.approx(10.0)


def test_refine_with_llm_returns_none_without_api_key(monkeypatch):
    monkeypatch.setattr(module.settings, "dashscope_api_key", "")
    monkeypatch.delenv("DASHSCOPE_API_KEY", raising=False)
    baseline, _ = build_heuristic_suggestion(_context())
    assert refine_with_llm(_context(), baseline) is None


def test_suggest_train_params_falls_back_to_heuristic(monkeypatch):
    project = SimpleNamespace(
        id="p1",
        name="鸟巢检测",
        task_type=SimpleNamespace(value="detect"),
    )
    context = _context(sample_count=250, small_object_likely=False)

    class FakeDB:
        def get(self, model, key):
            return project

    monkeypatch.setattr(module, "_build_context", lambda *_args, **_kwargs: context)
    monkeypatch.setattr(module, "refine_with_llm", lambda *_args, **_kwargs: None)
    result = suggest_train_params(FakeDB(), "p1")
    assert result["source"] == "heuristic"
    assert result["params"]["base_model"] == "yolov8n.pt"
    assert result["params"]["epochs"] >= 100
    assert "样本约 250" in result["reason"]


def test_suggest_train_params_uses_llm_when_available(monkeypatch):
    project = SimpleNamespace(id="p1", name="鸟巢检测", task_type=SimpleNamespace(value="detect"))
    context = _context(
        sample_count=1000,
        hardware=_hw(accelerator="cuda", gpu_name="RTX 5070 Ti", vram_gb=16.0, vram_free_gb=14.0, cpu_cores=16, ram_available_gb=40.0),
    )

    class FakeDB:
        def get(self, model, key):
            return project

    monkeypatch.setattr(module, "_build_context", lambda *_args, **_kwargs: context)
    monkeypatch.setattr(
        module,
        "refine_with_llm",
        lambda *_args, **_kwargs: {
            "params": {
                "epochs": 55,
                "imgsz": 640,
                "batch": 32,
                "base_model": "yolov8m.pt",
                "workers": 8,
                "patience": 20,
                "lr0": 0.01,
                "optimizer": "auto",
                "seed": 0,
                "close_mosaic": 10,
                "weight_decay": 0.0005,
                "warmup_epochs": 3,
            },
            "reason": "16GB 显存充足，提高 batch 以吃满 GPU",
        },
    )
    result = suggest_train_params(FakeDB(), "p1")
    assert result["source"] == "llm"
    assert result["params"]["epochs"] == 55
    assert result["params"]["batch"] == 32
    assert result["params"]["base_model"] == "yolov8m.pt"
    assert "显存" in result["reason"]
