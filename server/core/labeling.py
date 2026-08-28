"""VLM and YOLO labeling backends."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import time
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
from sqlalchemy.orm import Session

from server.config import settings
from server.core.paths import cache_dir
from server.core.yolo_io import YoloLabel, xywh_to_yolo
from server.db.models import Category, Frame, FrameStatus, Project, ProjectTaskType

VLM_PROMPT_VERSION = "detect-classify-v2"


def vlm_cache_identity(content_prompt_hash: str) -> str:
    return hashlib.sha256(
        "|".join(
            [
                content_prompt_hash,
                settings.vlm_model,
                settings.vlm_base_url.rstrip("/"),
                VLM_PROMPT_VERSION,
            ]
        ).encode("utf-8")
    ).hexdigest()


@dataclass
class ProposedBox:
    x: int
    y: int
    w: int
    h: int
    cls_id: int
    conf: float
    source: str


def _clamp_box(x: int, y: int, w: int, h: int, iw: int, ih: int) -> tuple[int, int, int, int] | None:
    x = max(0, min(x, iw - 1))
    y = max(0, min(y, ih - 1))
    w = max(1, min(w, iw - x))
    h = max(1, min(h, ih - y))
    if w < 8 or h < 8:
        return None
    return x, y, w, h


def _parse_json(text: str) -> dict:
    text = text.strip()
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if not m:
        raise ValueError(f"No JSON in response: {text[:200]}")
    return json.loads(m.group())


def _resize_for_vlm(img: np.ndarray, max_side: int = 1280) -> tuple[np.ndarray, float]:
    ih, iw = img.shape[:2]
    scale = 1.0
    if max(iw, ih) > max_side:
        scale = max_side / max(iw, ih)
        img = cv2.resize(img, (int(iw * scale), int(ih * scale)), interpolation=cv2.INTER_AREA)
    return img, scale


def build_detect_prompt(project: Project, categories: list[Category], iw: int, ih: int) -> str:
    lines: list[str] = []
    extra = (project.label_prompt or "").strip()
    if extra:
        lines.extend([extra, ""])
    lines.extend([
        "你是工业视觉标注员。请在图片中找到以下目标并返回像素级边界框（左上角 x,y + 宽 w + 高 h）。",
        "返回严格 JSON，不要 markdown：",
        "{",
        '  "boxes": [',
        '    {"class": "类名", "x": int, "y": int, "w": int, "h": int}',
        "  ],",
        '  "note": "简短说明（若无某类别请写明原因）"',
        "}",
        f"图片尺寸：{iw}x{ih} 像素。",
        "",
        "重要规则：",
        "- 框要紧贴目标，不要包含无关背景。",
        "- 并非每张图都包含所有类别；看不到就不要编造框。",
        "- 可选类别未出现时不输出该类别。",
        "",
        "类别说明：",
    ])
    for c in categories:
        req = "必须" if c.required else "可选（仅当清晰可见时才标）"
        lines.append(f"- {c.name}（{req}）: {c.description}")
    lines.append("同一类别可能有多个目标；必须为每个清晰可见的目标分别输出一个框。")
    return "\n".join(lines)


def build_classify_prompt(project: Project, categories: list[Category]) -> str:
    lines = [
        (project.label_prompt or "").strip(),
        "",
        "你是工业视觉分类员。判断整张图片属于哪个类别。",
        "返回严格 JSON：",
        '{"class": "类名", "confidence": 0.0-1.0, "note": "理由"}',
        "如果画面中没有相关目标，返回 {\"class\": \"none\", \"confidence\": 1.0, \"note\": \"无目标\"}",
        "",
        "类别说明：",
    ]
    for c in categories:
        lines.append(f"- {c.name}: {c.description}")
    return "\n".join([l for l in lines if l is not None])


def call_vlm(image_path: Path, prompt: str, cache_key: str | None = None, project_id: str | None = None) -> dict:
    api_key = settings.dashscope_api_key or os.environ.get("DASHSCOPE_API_KEY", "")
    if not api_key:
        raise RuntimeError("DASHSCOPE_API_KEY not configured")

    if cache_key and project_id:
        cache_identity = vlm_cache_identity(cache_key)
        cache_file = cache_dir(project_id) / "vlm" / f"{cache_identity}.json"
        cache_file.parent.mkdir(parents=True, exist_ok=True)
        if cache_file.exists():
            return json.loads(cache_file.read_text(encoding="utf-8"))

    from openai import OpenAI

    img = cv2.imread(str(image_path))
    if img is None:
        raise ValueError(f"Cannot read {image_path}")
    resized, _ = _resize_for_vlm(img)
    _, buf = cv2.imencode(".jpg", resized, [cv2.IMWRITE_JPEG_QUALITY, 85])
    b64 = base64.standard_b64encode(buf.tobytes()).decode("ascii")

    client = OpenAI(api_key=api_key, base_url=settings.vlm_base_url)
    for attempt in range(3):
        try:
            resp = client.chat.completions.create(
                model=settings.vlm_model,
                max_tokens=800,
                messages=[{
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}},
                    ],
                }],
            )
            result = _parse_json(resp.choices[0].message.content or "{}")
            if cache_key and project_id:
                cache_file.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
            return result
        except Exception:
            if attempt == 2:
                raise
            time.sleep(1.5 * (attempt + 1))
    return {}


def propose_detect(project: Project, categories: list[Category], image_path: Path) -> tuple[list[ProposedBox], str]:
    img = cv2.imread(str(image_path))
    if img is None:
        raise ValueError(f"Cannot read {image_path}")
    ih, iw = img.shape[:2]
    resized, scale = _resize_for_vlm(img)
    rih, riw = resized.shape[:2]
    prompt = build_detect_prompt(project, categories, riw, rih)
    h = hashlib.sha256()
    h.update(image_path.read_bytes())
    h.update(prompt.encode())
    result = call_vlm(image_path, prompt, h.hexdigest(), project.id)

    name_to_id = {c.name: c.class_id for c in categories}
    out: list[ProposedBox] = []
    inv_scale = 1.0 / scale if scale != 1.0 else 1.0
    for item in result.get("boxes", []):
        cls_name = item.get("class", "")
        cls_id = name_to_id.get(cls_name)
        if cls_id is None:
            for c in categories:
                if c.name in cls_name or cls_name in c.name:
                    cls_id = c.class_id
                    break
        if cls_id is None:
            continue
        raw = _clamp_box(
            int(item["x"] * inv_scale),
            int(item["y"] * inv_scale),
            int(item["w"] * inv_scale),
            int(item["h"] * inv_scale),
            iw, ih,
        )
        if raw:
            out.append(ProposedBox(*raw, cls_id=cls_id, conf=0.9, source="vlm"))
    note = result.get("note", "")
    return out, note


def propose_classify(project: Project, categories: list[Category], image_path: Path) -> tuple[int | None, float, str]:
    prompt = build_classify_prompt(project, categories)
    h = hashlib.sha256()
    h.update(image_path.read_bytes())
    h.update(prompt.encode())
    result = call_vlm(image_path, prompt, h.hexdigest(), project.id)
    cls_name = result.get("class", "none")
    if cls_name == "none":
        return None, float(result.get("confidence", 1.0)), result.get("note", "无目标")
    name_to_id = {c.name: c.class_id for c in categories}
    cls_id = name_to_id.get(cls_name)
    if cls_id is None:
        for c in categories:
            if c.name in cls_name or cls_name in c.name:
                cls_id = c.class_id
                break
    return cls_id, float(result.get("confidence", 0.9)), result.get("note", "")


def propose_yolo(model_path: Path, image_path: Path, conf: float = 0.25) -> list[ProposedBox]:
    from ultralytics import YOLO

    model = YOLO(str(model_path))
    results = model.predict(str(image_path), conf=conf, verbose=False)
    out: list[ProposedBox] = []
    if not results or results[0].boxes is None:
        return out
    for box in results[0].boxes:
        cls_id = int(box.cls.item())
        c = float(box.conf.item())
        x1, y1, x2, y2 = map(int, box.xyxy[0].tolist())
        out.append(ProposedBox(x1, y1, x2 - x1, y2 - y1, cls_id=cls_id, conf=c, source="yolo"))
    return out


def boxes_to_yolo_labels(boxes: list[ProposedBox], iw: int, ih: int) -> list[YoloLabel]:
    result: list[YoloLabel] = []
    for b in sorted(boxes, key=lambda x: -x.conf):
        xc, yc, w, h = xywh_to_yolo(b.x, b.y, b.w, b.h, iw, ih)
        result.append((b.cls_id, xc, yc, w, h))
    return result
