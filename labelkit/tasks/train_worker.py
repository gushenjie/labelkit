"""Subprocess worker entry for YOLO training."""

from __future__ import annotations

import json
import sys
from pathlib import Path


def main() -> int:
    payload_path = Path(sys.argv[1])
    p = json.loads(payload_path.read_text(encoding="utf-8"))

    from labelkit.config import load_config
    from labelkit.env_loader import load_env
    from labelkit.store import StateStore
    from labelkit.tasks.yolo_train import prepare_dataset, run_training

    load_env(p["config_path"])
    config = load_config(p["config_path"])
    store = StateStore(config)
    run_dir = Path(p["run_dir"])
    log_path = Path(p["log_path"])

    try:
        ds_yaml, stats = prepare_dataset(config, store, run_dir)
        out_model = Path(p["out_model"]) if p.get("out_model") else config.labels_dir.parent / "models" / "container_lid_labelkit.pt"
        project = run_dir / "ultralytics"
        result = run_training(
            data_yaml=ds_yaml,
            log_path=log_path,
            epochs=int(p["epochs"]),
            imgsz=int(p["imgsz"]),
            batch=int(p["batch"]),
            device=p.get("device"),
            base_model=p.get("base_model", "yolov8s.pt"),
            project=project,
            name=p.get("run_name", "train"),
            out_model=out_model,
        )
        result["dataset_stats"] = stats
        (run_dir / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        return 0 if result.get("ok") else 1
    except Exception as e:
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(f"ERROR: {e}\n")
        (run_dir / "result.json").write_text(json.dumps({"ok": False, "error": str(e)}), encoding="utf-8")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
