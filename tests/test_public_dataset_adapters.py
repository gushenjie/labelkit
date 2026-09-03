from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from server.core import public_dataset_adapters as adapters
from server.core.public_dataset_types import PublicImportDTO, PublicDatasetCandidateDTO


class FakeKaggleApi:
    def __init__(self):
        self.downloaded_ref = ""

    def dataset_list(self, **_kwargs):
        return [
            SimpleNamespace(
                ref="owner/bird-data",
                title="Bird data",
                subtitle="Detection images",
                license_name="CC0-1.0",
                total_bytes=1234,
                current_version_number=7,
                last_updated="2026-08-20",
            )
        ]

    def dataset_download_files(self, dataset, path, **_kwargs):
        self.downloaded_ref = dataset
        Path(path, "bird-data.zip").write_bytes(b"archive")


def _import_record(tmp_path: Path) -> PublicImportDTO:
    return PublicImportDTO(
        id="import-1",
        project_id="project-1",
        provider="kaggle",
        source_ref="owner/bird-data",
        source_version="7",
        source_url="https://www.kaggle.com/datasets/owner/bird-data",
        title="Bird data",
        license_name="CC0-1.0",
        license_url="https://www.kaggle.com/datasets/owner/bird-data",
        license_fingerprint="fingerprint",
        state="created",
        expected_download_bytes=1234,
        actual_download_bytes=0,
        extracted_bytes=0,
        artifact_checksum="",
        detected_format="",
        detected_root="",
        source_classes=(),
        class_mapping={},
        quality_report={},
        review_frame_ids=(),
        workflow_metadata={"task_type": "detect"},
        staging_path=tmp_path / "staging",
        fetch_task_id=None,
        import_task_id=None,
        dataset_version_id=None,
        train_task_id=None,
    )


def test_kaggle_candidate_uses_fixed_snake_case_version(monkeypatch):
    api = FakeKaggleApi()
    monkeypatch.setattr(adapters, "_kaggle_api", lambda: api)

    candidates = adapters.discover_kaggle("bird")

    assert candidates[0].source_version == "7"
    assert candidates[0].download_bytes == 1234
    assert candidates[0].license_name == "CC0-1.0"


def test_search_query_falls_back_without_llm_key(monkeypatch):
    monkeypatch.setattr(adapters.settings, "dashscope_api_key", "")
    monkeypatch.delenv("DASHSCOPE_API_KEY", raising=False)

    assert adapters.expand_search_query("厂区鸟巢识别", ["鸟窝"]) == "bird nest detection"
    assert adapters.expand_search_query("烟雾识别", ["鸟窝"]) == "smoke detection"


def test_localize_search_query_maps_chinese_cv_terms():
    assert "bird nest" in adapters.localize_search_query("鸟窝检测")
    assert "smoke" in adapters.localize_search_query("烟雾识别")
    assert adapters.localize_search_query("鸟类") == "bird"


def test_localize_search_query_maps_chinese_cv_terms():
    assert "bird nest" in adapters.localize_search_query("鸟窝检测")
    assert "smoke" in adapters.localize_search_query("烟雾识别")
    assert adapters.localize_search_query("鸟类") == "bird"
    assert adapters.localize_search_query("火焰") == "fire flame"


def test_search_query_maps_flame_without_llm_key(monkeypatch):
    monkeypatch.setattr(adapters.settings, "dashscope_api_key", "")
    monkeypatch.delenv("DASHSCOPE_API_KEY", raising=False)

    assert adapters.expand_search_query("火焰", ["fire"]) == "fire flame"


def test_rank_public_candidates_prefers_fire_over_unrelated_for_flame_query():
    fall = PublicDatasetCandidateDTO(
        provider="roboflow",
        source_ref="a/fall",
        source_version="1",
        source_url="https://universe.roboflow.com/a/fall/1",
        title="Fall Detection",
        description="person fall",
        license_name="CC BY 4.0",
        license_url="https://universe.roboflow.com/a/fall/1",
        download_bytes=None,
        image_count=5000,
        task_type="detect",
        classes=("Fall-Detected",),
        stars=50,
        downloads=900,
    )
    fire = PublicDatasetCandidateDTO(
        provider="roboflow",
        source_ref="b/fire",
        source_version="2",
        source_url="https://universe.roboflow.com/b/fire/2",
        title="Fire Detection",
        description="flame and smoke",
        license_name="CC BY 4.0",
        license_url="https://universe.roboflow.com/b/fire/2",
        download_bytes=None,
        image_count=800,
        task_type="detect",
        classes=("fire",),
        stars=4,
        downloads=20,
    )
    ranked = adapters.rank_public_candidates(
        [fall, fire],
        query="火焰",
        category_names=["fire"],
        task_type="detect",
    )
    assert ranked[0].source_ref == "b/fire"
    assert ranked[0].score > ranked[1].score


def test_kaggle_download_requests_the_confirmed_version(tmp_path, monkeypatch):
    captured: list[str] = []

    class FakeProcess:
        pid = 123
        returncode = 0

        def __init__(self, command, **_kwargs):
            captured.extend(command)
            download_dir = Path(command[command.index("-p") + 1])
            download_dir.mkdir(parents=True, exist_ok=True)
            (download_dir / "bird-data.zip").write_bytes(b"archive")

        def poll(self):
            return 0

    monkeypatch.setattr(adapters.subprocess, "Popen", FakeProcess)

    archives, _, _ = adapters.download_kaggle(_import_record(tmp_path), tmp_path / "downloads")

    assert "owner/bird-data/7" in captured
    assert archives[0].name == "bird-data.zip"


@pytest.mark.parametrize(
    "url",
    [
        "http://universe.roboflow.com/ws/project/1",
        "https://universe.roboflow.com/ws/project",
        "https://evil.example/ws/project/1",
        "https://universe.roboflow.com/ws/project/latest",
    ],
)
def test_roboflow_requires_official_fixed_version_url(url):
    with pytest.raises(RuntimeError):
        adapters.parse_roboflow_url(url)


def test_rank_public_candidates_prefers_class_match_and_good_size():
    weak = PublicDatasetCandidateDTO(
        provider="roboflow",
        source_ref="a/weak",
        source_version="1",
        source_url="https://universe.roboflow.com/a/weak/1",
        title="Random Objects",
        description="misc",
        license_name="unknown",
        license_url="https://universe.roboflow.com/a/weak/1",
        download_bytes=None,
        image_count=20,
        task_type="detect",
        classes=("car", "dog"),
    )
    strong = PublicDatasetCandidateDTO(
        provider="roboflow",
        source_ref="b/nest",
        source_version="2",
        source_url="https://universe.roboflow.com/b/nest/2",
        title="Bird Nest",
        description="power line nests",
        license_name="CC BY 4.0",
        license_url="https://universe.roboflow.com/b/nest/2",
        download_bytes=None,
        image_count=2800,
        task_type="detect",
        classes=("Nest", "nid"),
        stars=12,
        downloads=300,
    )
    ranked = adapters.rank_public_candidates(
        [weak, strong],
        query="鸟窝检测",
        category_names=["鸟窝"],
        task_type="detect",
    )
    assert ranked[0].source_ref == "b/nest"
    assert ranked[0].recommendation_reason.startswith("最推荐")
    assert ranked[0].score > ranked[1].score


def test_discover_roboflow_fixes_latest_version(monkeypatch):
    monkeypatch.setenv("ROBOFLOW_API_KEY", "rf_test_key")

    def fake_json(path: str):
        if "universe/search" in path:
            assert "bird" in path
            return {
                "results": [
                    {
                        "name": "Bird Nest",
                        "url": "https://universe.roboflow.com/ws/bird-nest",
                        "type": "object-detection",
                        "license": "CC BY 4.0",
                        "images": 120,
                        "classes": ["nest"],
                        "latestVersion": 3,
                        "description": "nests on poles",
                        "stars": 8,
                        "downloads": 120,
                        "thumbnail": "https://cdn.roboflow.com/thumb.png",
                        "annotationThumbnail": "https://cdn.roboflow.com/annot.png",
                    },
                    {
                        "name": "Train only fire",
                        "url": "https://universe.roboflow.com/ws/fire-only",
                        "type": "object-detection",
                        "license": "CC BY 4.0",
                        "images": 833,
                        "classes": ["Fire"],
                        "latestVersion": 5,
                    },
                    {
                        "name": "Seg only",
                        "url": "https://universe.roboflow.com/ws/seg",
                        "type": "instance-segmentation",
                        "license": "CC BY 4.0",
                        "images": 10,
                        "classes": ["nest"],
                        "latestVersion": 1,
                    },
                ]
            }
        if path.endswith("/bird-nest/3"):
            return {"version": {"splits": {"train": 100, "valid": 20}, "images": 120}}
        if path.endswith("/fire-only/5"):
            return {"version": {"splits": {"train": 833}, "images": 833}}
        raise AssertionError(f"unexpected roboflow path: {path}")

    monkeypatch.setattr(adapters, "_roboflow_json", fake_json)
    candidates, filtered = adapters.discover_roboflow("bird nest", task_type="detect")

    assert filtered == 1
    assert len(candidates) == 1
    assert candidates[0].provider == "roboflow"
    assert candidates[0].source_ref == "ws/bird-nest"
    assert candidates[0].source_version == "3"
    assert candidates[0].source_url == "https://universe.roboflow.com/ws/bird-nest/dataset/3"
    assert candidates[0].license_url == candidates[0].source_url
    assert candidates[0].task_type == "detect"
    assert candidates[0].classes == ("nest",)
    assert candidates[0].stars == 8
    assert candidates[0].downloads == 120
    assert candidates[0].thumbnail == "https://cdn.roboflow.com/thumb.png"
    assert candidates[0].annotation_thumbnail == "https://cdn.roboflow.com/annot.png"


def test_fetch_roboflow_preview_prefers_dataset_sample_over_project_thumbnail(monkeypatch):
    monkeypatch.setenv("ROBOFLOW_API_KEY", "rf_test_key")
    calls: list[tuple[str, str | None]] = []

    def fake_json(path: str) -> dict:
        calls.append(("GET", path))
        if path.endswith("/fire-fhsxx/2"):
            return {
                "project": {
                    "annotationThumbnail": "https://cdn.roboflow.com/detail-annot.png",
                }
            }
        if path.endswith("/images/img-1"):
            return {"image": {"urls": {"thumb": "https://cdn.roboflow.com/thumb.jpg"}}}
        raise RuntimeError("unexpected path")

    def fake_post(path: str, body: dict) -> dict:
        calls.append(("POST", path))
        assert body["limit"] == 1
        assert body["in_dataset"] is True
        assert "url" not in body["fields"]
        return {"results": [{"id": "img-1"}]}

    monkeypatch.setattr(adapters, "_roboflow_json", fake_json)
    monkeypatch.setattr(adapters, "_roboflow_post_json", fake_post)

    thumbnail, annotation_thumbnail = adapters.fetch_roboflow_preview("gadjiiavov-n4n8k/fire-fhsxx", "2")

    assert thumbnail == "https://cdn.roboflow.com/thumb.jpg"
    assert annotation_thumbnail is None
    assert ("POST", "gadjiiavov-n4n8k/fire-fhsxx/search") in calls
    assert ("GET", "gadjiiavov-n4n8k/fire-fhsxx/images/img-1") in calls
    assert ("GET", "gadjiiavov-n4n8k/fire-fhsxx/2") not in calls


def test_fetch_roboflow_preview_falls_back_to_sample_image(monkeypatch):
    monkeypatch.setenv("ROBOFLOW_API_KEY", "rf_test_key")

    def fake_json(path: str) -> dict:
        if path.endswith("/fire-fhsxx/2"):
            return {"project": {}, "version": {}}
        if path.endswith("/images/img-1"):
            return {"image": {"urls": {"thumb": "https://cdn.roboflow.com/thumb.jpg", "original": "https://cdn.roboflow.com/original.jpg"}}}
        raise RuntimeError(path)

    def fake_post(path: str, body: dict) -> dict:
        return {"results": [{"id": "img-1"}]}

    monkeypatch.setattr(adapters, "_roboflow_json", fake_json)
    monkeypatch.setattr(adapters, "_roboflow_post_json", fake_post)

    thumbnail, annotation_thumbnail = adapters.fetch_roboflow_preview("gadjiiavov-n4n8k/fire-fhsxx", "2")

    assert thumbnail == "https://cdn.roboflow.com/thumb.jpg"
    assert annotation_thumbnail is None


def test_image_record_uses_original_as_real_thumbnail_fallback():
    thumbnail, annotation_thumbnail = adapters._preview_from_image_record(
        {
            "urls": {
                "original": "https://cdn.roboflow.com/original.jpg",
                "annotation": "https://cdn.roboflow.com/annotation-overlay.png",
            }
        }
    )

    assert thumbnail == "https://cdn.roboflow.com/original.jpg"
    assert annotation_thumbnail == "https://cdn.roboflow.com/annotation-overlay.png"


def test_fetch_roboflow_preview_falls_back_to_version_metadata(monkeypatch):
    monkeypatch.setenv("ROBOFLOW_API_KEY", "rf_test_key")

    monkeypatch.setattr(adapters, "_roboflow_post_json", lambda path, body: {"results": []})
    monkeypatch.setattr(
        adapters,
        "_roboflow_json",
        lambda path: {
            "project": {
                "annotationThumbnail": "https://cdn.roboflow.com/wrong-project-cover.jpg",
                "icon": "https://cdn.roboflow.com/workspace-logo.png",
            },
            "version": {
                "annotationThumbnail": "https://cdn.roboflow.com/version-annotated.jpg",
            },
        },
    )

    thumbnail, annotation_thumbnail = adapters.fetch_roboflow_preview("ws/project", "4")

    assert thumbnail is None
    assert annotation_thumbnail == "https://cdn.roboflow.com/version-annotated.jpg"


def test_inspect_roboflow_url_normalizes_to_dataset_route(monkeypatch):
    monkeypatch.setattr(
        adapters,
        "_roboflow_json",
        lambda path: {
            "project": {"type": "object-detection", "name": "Fire", "license": "CC BY 4.0"},
            "version": {"classes": ["fire"], "images": 10, "splits": {"train": 8, "valid": 2}},
        },
    )

    candidate = adapters.inspect_roboflow_url("https://universe.roboflow.com/ws/fire/2")

    assert candidate.source_url == "https://universe.roboflow.com/ws/fire/dataset/2"
    assert candidate.license_url == candidate.source_url


def test_inspect_roboflow_url_rejects_train_only_detect_dataset(monkeypatch):
    monkeypatch.setattr(
        adapters,
        "_roboflow_json",
        lambda path: {
            "project": {"type": "object-detection", "name": "Fire", "license": "CC BY 4.0"},
            "version": {"classes": ["Fire"], "images": 833, "splits": {"train": 833}},
        },
    )

    with pytest.raises(RuntimeError, match="仅有训练集"):
        adapters.inspect_roboflow_url(
            "https://universe.roboflow.com/ws/fire/5",
            task_type="detect",
        )
