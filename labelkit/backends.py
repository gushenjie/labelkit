"""Pluggable labeling backends: VLM and YOLO."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from labelkit.config import ProjectConfig
from labelkit.yolo_io import xywh_to_yolo


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


def _resize_for_vlm(img: np.ndarray, max_side: int) -> tuple[np.ndarray, float]:
    ih, iw = img.shape[:2]
    scale = 1.0
    if max(iw, ih) > max_side:
        scale = max_side / max(iw, ih)
        img = cv2.resize(img, (int(iw * scale), int(ih * scale)), interpolation=cv2.INTER_AREA)
    return img, scale


class LabelBackend(ABC):
    @abstractmethod
    def propose(self, image_path: Path) -> list[ProposedBox]:
        ...


class VlmBackend(LabelBackend):
    def __init__(self, config: ProjectConfig):
        self.config = config
        self.cache_dir = config.state_dir / "cache" / "vlm"
        self.cache_dir.mkdir(parents=True, exist_ok=True)

    def _cache_key(self, image_path: Path, prompt: str) -> str:
        h = hashlib.sha256()
        h.update(image_path.read_bytes())
        h.update(prompt.encode())
        h.update(self.config.vlm.model.encode())
        return h.hexdigest()

    def _build_prompt(self, iw: int, ih: int) -> str:
        lines = [
            "你是工业视觉标注员。请在图片中找到以下目标并返回像素级边界框（左上角 x,y + 宽 w + 高 h）。",
            "返回严格 JSON，不要 markdown：",
            "{",
            '  "boxes": [',
            '    {"class": "类名", "x": int, "y": int, "w": int, "h": int}',
            "  ],",
            '  "note": "简短说明"',
            "}",
            f"图片尺寸：{iw}x{ih} 像素。",
            "类别说明：",
        ]
        for c in self.config.classes:
            lines.append(f'- {c.name}: {c.prompt}')
        lines.append("每个类别最多一个框。找不到的类别不要输出。")
        return "\n".join(lines)

    def _call_vlm(self, b64: str, prompt: str) -> dict:
        api_key = os.environ.get(self.config.vlm.api_key_env)
        if not api_key:
            raise RuntimeError(f"{self.config.vlm.api_key_env} not set")

        try:
            from openai import OpenAI
        except ImportError as e:
            raise RuntimeError("pip install openai") from e

        client = OpenAI(api_key=api_key, base_url=self.config.vlm.base_url)
        for attempt in range(3):
            try:
                resp = client.chat.completions.create(
                    model=self.config.vlm.model,
                    max_tokens=800,
                    messages=[
                        {
                            "role": "user",
                            "content": [
                                {"type": "text", "text": prompt},
                                {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}},
                            ],
                        }
                    ],
                )
                return _parse_json(resp.choices[0].message.content or "{}")
            except Exception:
                if attempt == 2:
                    raise
                time.sleep(1.5 * (attempt + 1))
        return {}

    def propose(self, image_path: Path) -> list[ProposedBox]:
        img = cv2.imread(str(image_path))
        if img is None:
            raise ValueError(f"Cannot read {image_path}")
        ih, iw = img.shape[:2]
        resized, scale = _resize_for_vlm(img, self.config.vlm.max_side)
        rih, riw = resized.shape[:2]
        prompt = self._build_prompt(riw, rih)
        cache_key = self._cache_key(image_path, prompt)
        cache_file = self.cache_dir / f"{cache_key}.json"
        if cache_file.exists():
            result = json.loads(cache_file.read_text(encoding="utf-8"))
        else:
            _, buf = cv2.imencode(".jpg", resized, [cv2.IMWRITE_JPEG_QUALITY, 85])
            b64 = base64.standard_b64encode(buf.tobytes()).decode("ascii")
            result = self._call_vlm(b64, prompt)
            cache_file.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")

        name_to_id = {c.name: c.id for c in self.config.classes}
        out: list[ProposedBox] = []
        inv_scale = 1.0 / scale if scale != 1.0 else 1.0

        for item in result.get("boxes", []):
            cls_name = item.get("class", "")
            cls_id = name_to_id.get(cls_name)
            if cls_id is None:
                for c in self.config.classes:
                    if c.name in cls_name or cls_name in c.name:
                        cls_id = c.id
                        break
            if cls_id is None:
                continue
            raw = _clamp_box(
                int(item["x"] * inv_scale),
                int(item["y"] * inv_scale),
                int(item["w"] * inv_scale),
                int(item["h"] * inv_scale),
                iw,
                ih,
            )
            if raw:
                out.append(ProposedBox(*raw, cls_id=cls_id, conf=0.9, source="vlm"))
        return out


class YoloBackend(LabelBackend):
    def __init__(self, config: ProjectConfig):
        self.config = config
        if not config.yolo.model:
            raise RuntimeError("yolo.model not configured")
        model_path = Path(config.yolo.model)
        if not model_path.is_absolute():
            model_path = (config.root / model_path).resolve()
        try:
            from ultralytics import YOLO
        except ImportError as e:
            raise RuntimeError("pip install ultralytics") from e
        self.model = YOLO(str(model_path))
        self.conf = config.yolo.conf

    def propose(self, image_path: Path) -> list[ProposedBox]:
        results = self.model.predict(str(image_path), conf=self.conf, verbose=False)
        out: list[ProposedBox] = []
        if not results:
            return out
        r = results[0]
        if r.boxes is None:
            return out
        for box in r.boxes:
            cls_id = int(box.cls.item())
            conf = float(box.conf.item())
            x1, y1, x2, y2 = map(int, box.xyxy[0].tolist())
            out.append(
                ProposedBox(
                    x1, y1, x2 - x1, y2 - y1,
                    cls_id=cls_id,
                    conf=conf,
                    source="yolo",
                )
            )
        return out


def get_backend(config: ProjectConfig, name: str) -> LabelBackend:
    if name == "yolo":
        return YoloBackend(config)
    if name == "vlm":
        return VlmBackend(config)
    raise ValueError(f"Unknown backend: {name}")


def boxes_to_yolo_dict(boxes: list[ProposedBox], iw: int, ih: int) -> dict[int, tuple[float, float, float, float]]:
    result: dict[int, tuple[float, float, float, float]] = {}
    for b in sorted(boxes, key=lambda x: -x.conf):
        if b.cls_id not in result:
            result[b.cls_id] = xywh_to_yolo(b.x, b.y, b.w, b.h, iw, ih)
    return result
