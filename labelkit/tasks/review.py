"""LLM auto-review task."""

from __future__ import annotations

import base64
import json
import os
import re
import time
from pathlib import Path

import cv2

from labelkit.config import ProjectConfig
from labelkit.datasets import iter_target_frames
from labelkit.rules import check_rules
from labelkit.store import FrameStatus, StateStore
from labelkit.visualize import save_review_image
from labelkit.yolo_io import parse_labels, write_labels


REVIEW_PROMPT = """你是标注质量审查员。图片上已画了检测框和类别名。
请审查每个框是否正确，返回严格 JSON（不要 markdown，所有字符串必须用双引号）：
{{
  "verdict": "pass",
  "issues": [],
  "boxes": [
    {{"class": "bucket", "verdict": "correct", "note": ""}}
  ],
  "summary": "一句话总结"
}}
verdict 只能是 "pass" 或 "fail"。
审查标准：
{standards}
{extra}
图片尺寸 {iw}x{ih}。
- pass：必需类别正确；可选类别正确（无盖时不应有 lid 框）。
- fail：框偏移、漏标、误标、无盖却标了 lid、把桶口/把手标成 lid。"""


def _parse_json(text: str) -> dict:
    text = text.strip()
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if not m:
        raise ValueError(f"No JSON: {text[:200]}")
    return json.loads(m.group())


def _call_vlm_review(config: ProjectConfig, img_path: Path, prompt: str) -> dict:
    api_key = os.environ.get(config.vlm.api_key_env)
    if not api_key:
        raise RuntimeError(f"{config.vlm.api_key_env} not set")
    from openai import OpenAI

    b64 = base64.standard_b64encode(img_path.read_bytes()).decode("ascii")
    client = OpenAI(api_key=api_key, base_url=config.vlm.base_url)
    for attempt in range(3):
        try:
            resp = client.chat.completions.create(
                model=config.vlm.model,
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


def run_review(
    config: ProjectConfig,
    store: StateStore,
    *,
    only: str | None = None,
    limit: int = 0,
) -> dict[str, int]:
    frames = iter_target_frames(
        config,
        store,
        only=only,
        limit=limit,
        statuses={FrameStatus.LLM_LABELED, FrameStatus.AUTO_FIXED, FrameStatus.NEEDS_HUMAN},
    )
    review_dir = config.state_dir / "review_images"
    standards_lines = []
    for c in config.classes:
        req = "必需" if c.required else "可选（无则不应有框）"
        standards_lines.append(f"- {c.name}（{req}）: {c.prompt}")
    standards = "\n".join(standards_lines)
    extra = config.prompts.get("review", "").strip()

    pass_n = fail_n = skip = 0
    for frame in frames:
        rec = store.get(frame.id)
        if rec and rec.status == FrameStatus.HUMAN_OK:
            skip += 1
            continue
        if not frame.label_path.exists():
            store.update(frame.id, FrameStatus.NEEDS_HUMAN, note="no labels", source="review")
            fail_n += 1
            continue

        img = cv2.imread(str(frame.image_path))
        ih, iw = img.shape[:2]
        labels = parse_labels(frame.label_path.read_text())
        rule = check_rules(config, labels, iw, ih)

        review_img = review_dir / f"{frame.split}_{frame.stem}.jpg"
        save_review_image(config, frame.image_path, frame.label_path, review_img)

        prompt = REVIEW_PROMPT.format(standards=standards, extra=extra or "（无额外说明）", iw=iw, ih=ih)
        try:
            has_api = bool(os.environ.get(config.vlm.api_key_env))
            if has_api:
                result = _call_vlm_review(config, review_img, prompt)
                verdict = result.get("verdict", "fail")
                summary = result.get("summary", "")
                issues = result.get("issues", [])
            else:
                result = {"verdict": "pass" if rule.ok else "fail", "issues": rule.issues}
                verdict = result["verdict"]
                summary = "仅规则审查（未配置 VLM API Key，请在 labelkit/.env 填写）"
                issues = rule.issues
            review_note = summary or "; ".join(issues)
            if rule.ok and verdict == "pass":
                store.update(
                    frame.id, FrameStatus.AUTO_OK,
                    review_note=review_note, source="review",
                    extra={"llm_verdict": result},
                )
                pass_n += 1
            else:
                note = "; ".join(rule.issues + issues)
                store.update(
                    frame.id, FrameStatus.NEEDS_HUMAN,
                    note=note, review_note=review_note, source="review",
                    extra={"llm_verdict": result},
                )
                fail_n += 1
        except Exception as e:
            note = "; ".join(rule.issues) if not rule.ok else str(e)
            status = FrameStatus.NEEDS_HUMAN if not rule.ok else FrameStatus.AUTO_OK
            store.update(frame.id, status, note=note, review_note=str(e), source="review")
            if status == FrameStatus.AUTO_OK:
                pass_n += 1
            else:
                fail_n += 1

    store.save()
    return {"pass": pass_n, "fail": fail_n, "skip": skip}
