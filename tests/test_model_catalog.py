from server.api.model_catalog_schemas import ModelCatalogOut
from server.core.model_catalog import TrainingModel, get_model_catalog


def test_model_catalog_matches_global_model_center_contract():
    catalog = ModelCatalogOut.model_validate(get_model_catalog())

    assert catalog.total == 6
    assert len(catalog.stats) == 4
    assert len(catalog.models) == 6
    assert {model.framework for model in catalog.models} == {
        "PaddlePaddle",
        "PyTorch",
        "TensorFlow",
    }
    assert catalog.models[0].name == "YOLOv8"
    assert len(catalog.models[0].metrics) == 2


def test_model_catalog_includes_project_training_versions_before_built_ins():
    catalog = get_model_catalog([
        TrainingModel(
            id="model-1",
            project_id="project-1",
            name="v2",
            version=2,
            project_name="火焰检测",
            task_type="detect",
            metrics={"metrics/mAP50(B)": 0.8, "metrics/precision(B)": 0.75},
            base_model="yolov8s.pt",
            updated_at="2026年8月31日",
        )
    ])

    assert catalog["total"] == 7
    assert catalog["models"][0]["source"] == "训练模型"
    assert catalog["models"][0]["project_name"] == "火焰检测"
    assert catalog["models"][0]["metrics"][0]["value"] == "80.0%"
