"""LabelKit review web application."""

from __future__ import annotations

from pathlib import Path
from threading import Timer

import cv2
from flask import Flask, jsonify, render_template, request, send_file

from labelkit.config import load_config
from labelkit.datasets import list_frames
from labelkit.env_loader import load_env
from labelkit.store import FrameStatus, StateStore
from labelkit.tasks.label import run_label
from labelkit.visualize import draw_labeled_image

TEMPLATE_DIR = Path(__file__).resolve().parent / "templates"


def create_app(config_path: str | Path) -> Flask:
    config = load_config(config_path)
    store = StateStore(config)
    store.sync_frames()

    app = Flask(__name__, template_folder=str(TEMPLATE_DIR))
    app.config["LABELKIT_CONFIG"] = config
    app.config["LABELKIT_STORE"] = store

    @app.route("/")
    def index():
        return render_template("review.html", project=config.name, classes=config.classes)

    @app.route("/api/stats")
    def api_stats():
        store.sync_frames()
        stats = store.stats()
        return jsonify(stats)

    @app.route("/api/frames")
    def api_frames():
        split = request.args.get("split") or None
        prefix = request.args.get("prefix") or None
        status = request.args.get("status") or None
        st = FrameStatus(status) if status and status != "all" else None
        frames = list_frames(config, store, split=split, prefix=prefix, status=st)
        return jsonify({
            "frames": [
                {
                    "id": f.id,
                    "split": f.split,
                    "stem": f.stem,
                    "status": f.status.value,
                    "note": f.note,
                    "review_note": f.review_note,
                    "has_labels": f.has_labels,
                    "prefix": f.prefix,
                }
                for f in frames
            ],
            "total": len(frames),
        })

    @app.route("/api/preview/<split>/<stem>")
    def api_preview(split: str, stem: str):
        img_path = config.images_dir / split / f"{stem}.jpg"
        lbl_path = config.labels_dir / split / f"{stem}.txt"
        if not img_path.exists():
            return jsonify({"error": "not found"}), 404
        img = draw_labeled_image(config, img_path, lbl_path=lbl_path)
        cache = config.state_dir / "preview_cache" / f"{split}_{stem}.jpg"
        cache.parent.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(cache), img, [cv2.IMWRITE_JPEG_QUALITY, 92])
        return send_file(cache, mimetype="image/jpeg")

    @app.route("/api/feedback", methods=["POST"])
    def api_feedback():
        body = request.get_json(force=True)
        frame_id = body.get("id")
        action = body.get("status")
        note = body.get("note", "")
        if not frame_id or action not in ("human_ok", "human_wrong", "pending"):
            return jsonify({"error": "invalid"}), 400
        if action == "pending":
            rec = store.get(frame_id)
            if rec:
                store._data["frames"].pop(frame_id, None)
                store.save()
        else:
            store.human_update(frame_id, FrameStatus(action), note=note)
            store.save()
        return jsonify({"ok": True})

    @app.route("/api/relabel/<split>/<stem>", methods=["POST"])
    def api_relabel(split: str, stem: str):
        frame_id = f"{split}/{stem}"
        rec = store.get(frame_id)
        if rec and rec.status == FrameStatus.HUMAN_OK:
            return jsonify({"error": "human_ok protected"}), 403
        frame = next((f for f in list_frames(config, store) if f.id == frame_id), None)
        if not frame:
            return jsonify({"error": "not found"}), 404
        stats = run_label(config, store, backend_name="vlm", only=stem, limit=1, force=True)
        store.save()
        return jsonify({"ok": True, "stats": stats})

    @app.route("/api/prefixes")
    def api_prefixes():
        frames = list_frames(config, store)
        prefixes = sorted({f.prefix for f in frames})
        return jsonify({"prefixes": prefixes})

    return app


def run_server(config_path: str | Path, port: int = 8765, open_browser: bool = True) -> None:
    import webbrowser

    loaded = load_env(config_path)
    config = load_config(config_path)
    url = f"http://127.0.0.1:{port}"
    print(f"LabelKit review: {url}")
    print(f"Project: {config.name}")
    print(f"State: {config.state_dir / 'state.json'}")
    if loaded:
        print(f"已加载本地配置: {', '.join(loaded)}")
    from labelkit.env_loader import api_key_configured
    if api_key_configured(config.vlm.api_key_env):
        print("VLM API Key: 已配置")
    else:
        print(f"VLM API Key: 未配置（请填写 .env 或 {config.vlm.api_key_env}）")
    if open_browser:
        Timer(1.0, lambda: webbrowser.open(url)).start()
    app = create_app(config_path)
    app.run(host="127.0.0.1", port=port, debug=False)
