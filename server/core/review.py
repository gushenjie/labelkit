"""Review task runner — VLM only."""

from __future__ import annotations

import base64
import json
import os
import re
from collections.abc import Callable
from pathlib import Path

from sqlalchemy.orm import Session

from server.config import settings
from server.core.image_io import read_image_bgr
from server.core.visualize import save_review_image
from server.db.models import Category, Frame, FrameStatus, Project, ProjectTaskType, Task
from server.repositories.material_repository import active_frame_filter


REVIEW_PROMPT = """你是标注质量审查员。图片上已画了检测框和类别名。
请审查每个框是否正确，返回严格 JSON：
{{"verdict": "pass", "issues": [], "summary": "一句话总结"}}
verdict 只能是 "pass" 或 "fail"。
审查标准：
{standards}
{extra}
图片尺寸 {iw}x{ih}。
- pass：框位置准确，无漏标、无误标；画面中无目标时不应有框。
- fail：框偏移、漏标、误标、编造目标。"""

# 接口/鉴权类错误：只应提示任务失败一次，不得写入帧「审查提示」
_INFRA_NOTE_MARKERS = (
    "access_denied",
    "error code:",
    "chatcmpl-",
    "request_id",
    "dashscope",
    "api key",
    "unauthorized",
    "authentication",
    "rate limit",
    "insufficient_quota",
    "connection error",
    "timed out",
    "timeout",
)


class ReviewInfraError(RuntimeError):
    """机器预审基础设施错误（鉴权、配额、网络等）。"""


def is_infra_review_note(note: str) -> bool:
    text = (note or "").strip().lower()
    if not text:
        return False
    return any(marker in text for marker in _INFRA_NOTE_MARKERS)


def scrub_infra_review_notes(db: Session, frames: list[Frame]) -> int:
    """清理误写入帧上的接口错误文案；返回清理条数。"""
    cleared = 0
    for frame in frames:
        if is_infra_review_note(frame.review_note or ""):
            frame.review_note = ""
            cleared += 1
    if cleared:
        db.commit()
    return cleared


def _friendly_infra_message(exc: BaseException) -> str:
    text = str(exc)
    lower = text.lower()
    if "access_denied" in lower or "403" in lower:
        return "机器预审失败：当前视觉模型无访问权限，请在系统设置更换可用模型后重试"
    if "api key" in lower or "unauthorized" in lower or "401" in lower:
        return "机器预审失败：API Key 无效或未配置，请在系统设置中检查"
    if "rate limit" in lower or "insufficient_quota" in lower:
        return "机器预审失败：调用额度或限流不足，请稍后重试"
    if "timeout" in lower or "timed out" in lower or "connection" in lower:
        return "机器预审失败：网络异常，请稍后重试"
    return f"机器预审失败：{text[:160]}"


def _parse_json(text: str) -> dict:
    text = text.strip()
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if not m:
        raise ValueError(f"No JSON: {text[:200]}")
    return json.loads(m.group())


def _call_vlm_review(image_path: Path, prompt: str) -> dict:
    api_key = settings.dashscope_api_key or os.environ.get("DASHSCOPE_API_KEY", "")
    if not api_key:
        raise ReviewInfraError("未配置 API Key")
    from openai import OpenAI

    b64 = base64.standard_b64encode(image_path.read_bytes()).decode("ascii")
    client = OpenAI(api_key=api_key, base_url=settings.vlm_base_url)
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
    return _parse_json(resp.choices[0].message.content or "{}")


def run_review_task(db: Session, task: Task, *, cancelled: Callable[[], bool] | None = None) -> None:
    project = db.get(Project, task.project_id)
    categories = db.query(Category).filter(Category.project_id == project.id).all()
    standards = "\n".join(f"- {c.name}: {c.description}" for c in categories)
    extra = project.review_prompt or "（无额外说明）"

    statuses = {FrameStatus.LLM_LABELED, FrameStatus.AUTO_FIXED, FrameStatus.NEEDS_HUMAN}
    frames = db.query(Frame).filter(
        Frame.project_id == project.id,
        active_frame_filter(),
        Frame.status.in_(statuses),
    ).order_by(Frame.uncertainty.desc()).all()

    task.total = len(frames)
    db.commit()
    pass_n = fail_n = 0

    from server.core.paths import cache_dir, label_path_for_frame
    review_path = cache_dir(project.id) / "review_images"
    review_path.mkdir(parents=True, exist_ok=True)

    for i, frame in enumerate(frames):
        if cancelled and cancelled():
            break
        if frame.status == FrameStatus.HUMAN_OK:
            continue

        if project.task_type == ProjectTaskType.CLASSIFY:
            anns = frame.annotations
            if not anns and frame.status != FrameStatus.NO_TARGET:
                frame.status = FrameStatus.NEEDS_HUMAN
                frame.review_note = "无分类标签"
                fail_n += 1
            else:
                frame.status = FrameStatus.AUTO_OK
                frame.review_note = "分类标注通过"
                pass_n += 1
            task.progress = i + 1
            continue

        lbl_path = label_path_for_frame(project.id, frame)
        img_path = Path(frame.filepath)
        img = read_image_bgr(img_path)
        if img is None:
            frame.review_note = f"无法读取图片: {img_path}"
            fail_n += 1
            task.progress = i + 1
            continue
        ih, iw = img.shape[:2]

        review_img = review_path / f"{frame.id}.jpg"
        save_review_image(categories, img_path, lbl_path, review_img)
        prompt = REVIEW_PROMPT.format(standards=standards, extra=extra, iw=iw, ih=ih)
        try:
            result = _call_vlm_review(review_img, prompt)
            verdict = result.get("verdict", "fail")
            summary = result.get("summary", "")
            issues = result.get("issues", [])
            review_note = summary or "; ".join(issues)
            if verdict == "pass":
                frame.status = FrameStatus.AUTO_OK
                frame.review_note = review_note
                pass_n += 1
            else:
                frame.status = FrameStatus.NEEDS_HUMAN
                frame.note = "; ".join(issues) if issues else summary
                frame.review_note = review_note
                fail_n += 1
        except ReviewInfraError as error:
            task.result = {"pass": pass_n, "fail": fail_n, "aborted": True}
            raise ReviewInfraError(_friendly_infra_message(error)) from error
        except Exception as error:
            if is_infra_review_note(str(error)):
                task.result = {"pass": pass_n, "fail": fail_n, "aborted": True}
                raise ReviewInfraError(_friendly_infra_message(error)) from error
            # 单帧业务异常仍记在该帧，不中断整批
            frame.status = FrameStatus.NEEDS_HUMAN
            frame.review_note = str(error)[:200]
            fail_n += 1

        task.progress = i + 1
        if i % 5 == 0:
            db.commit()

    task.result = {"pass": pass_n, "fail": fail_n}
    db.commit()
