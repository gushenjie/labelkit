from __future__ import annotations

from server.core.labeling import vlm_cache_identity


def test_cache_changes_with_model_and_base_url():
    first = vlm_cache_identity(
        "same-image-and-prompt",
        vlm_model="model-a",
        vlm_base_url="https://api-a.example/v1",
    )
    second = vlm_cache_identity(
        "same-image-and-prompt",
        vlm_model="model-b",
        vlm_base_url="https://api-a.example/v1",
    )
    third = vlm_cache_identity(
        "same-image-and-prompt",
        vlm_model="model-a",
        vlm_base_url="https://api-b.example/v1",
    )

    assert len({first, second, third}) == 3
