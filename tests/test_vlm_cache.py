from __future__ import annotations

from server.config import settings
from server.core.labeling import vlm_cache_identity


def test_cache_changes_with_model_and_base_url(monkeypatch):
    monkeypatch.setattr(settings, "vlm_model", "model-a")
    monkeypatch.setattr(settings, "vlm_base_url", "https://api-a.example/v1")
    first = vlm_cache_identity("same-image-and-prompt")

    monkeypatch.setattr(settings, "vlm_model", "model-b")
    second = vlm_cache_identity("same-image-and-prompt")
    monkeypatch.setattr(settings, "vlm_model", "model-a")
    monkeypatch.setattr(settings, "vlm_base_url", "https://api-b.example/v1")
    third = vlm_cache_identity("same-image-and-prompt")

    assert len({first, second, third}) == 3
