from __future__ import annotations

from server.core.vlm_profiles import (
    RECOMMENDED_DEFAULT_MODEL,
    VlmProfile,
    enrich_with_recommended_presets,
    migrate_profiles,
    prune_superseded_presets,
    resolve_profile,
    serialize_profiles,
)


def test_migrate_profiles_keeps_one_per_vendor():
    profiles, default_id = migrate_profiles(
        {
            "vlm_model": "qwen2.5-vl-72b-instruct",
            "vlm_base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
            "vlm_cost_per_image": 0.03,
            "vlm_profiles": [
                {
                    "id": "a",
                    "name": "通义 72B",
                    "model": "qwen2.5-vl-72b-instruct",
                    "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
                    "cost_per_image": 0.03,
                    "enabled": True,
                },
                {
                    "id": "b",
                    "name": "通义 VL-Plus",
                    "model": "qwen-vl-plus",
                    "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
                    "cost_per_image": 0.01,
                    "enabled": True,
                },
            ],
        }
    )
    models = [profile.model for profile in profiles]
    assert models.count("qwen2.5-vl-72b-instruct") == 0
    assert models.count("qwen-vl-plus") == 0
    assert RECOMMENDED_DEFAULT_MODEL in models
    assert "glm-4v-plus" in models
    assert len(profiles) == 2
    current = next(profile for profile in profiles if profile.id == default_id)
    assert current.model == RECOMMENDED_DEFAULT_MODEL


def test_prune_superseded_presets():
    seed = [
        VlmProfile("1", "旧", "qwen2.5-vl-72b-instruct", "https://x", 0.03, True),
        VlmProfile("2", "新", RECOMMENDED_DEFAULT_MODEL, "https://x", 0.02, True),
        VlmProfile("3", "自定义", "my-custom-vl", "https://x", 0.01, True),
    ]
    pruned = prune_superseded_presets(seed)
    assert [item.model for item in pruned] == [RECOMMENDED_DEFAULT_MODEL, "my-custom-vl"]


def test_enrich_adds_missing_vendor_best():
    seed = [
        VlmProfile(
            id="old",
            name="自定义",
            model="my-custom-vl",
            base_url="https://example.com/v1",
            cost_per_image=0.02,
            enabled=True,
        )
    ]
    enriched = enrich_with_recommended_presets(seed)
    models = {item.model for item in enriched}
    assert "my-custom-vl" in models
    assert RECOMMENDED_DEFAULT_MODEL in models
    assert "glm-4v-plus" in models


def test_resolve_profile_falls_back_to_default():
    profiles, default_id = migrate_profiles({})
    data = serialize_profiles(profiles, default_id)
    resolved = resolve_profile(None, data=data)
    assert resolved.id == default_id
    assert resolved.model == RECOMMENDED_DEFAULT_MODEL
    other = next(p for p in profiles if p.id != default_id)
    selected = resolve_profile(other.id, data=data)
    assert selected.id == other.id
