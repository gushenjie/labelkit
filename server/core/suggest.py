"""LLM suggestions for material count and class descriptions."""

from __future__ import annotations

import random
from pathlib import Path

from sqlalchemy.orm import Session

from server.core.labeling import call_vlm
from server.db.models import Category, Frame, Project, Video


def suggest_frame_count(db: Session, project_id: str) -> dict:
    project = db.get(Project, project_id)
    frames = db.query(Frame).filter(Frame.project_id == project_id).limit(5).all()
    videos = db.query(Video).filter(Video.project_id == project_id).all()
    total_duration = sum(v.duration_sec or 0 for v in videos)

    if not frames and not videos:
        return {"suggested_count": 100, "reason": "默认建议：先上传视频后抽帧 100 张左右作为起点"}

    sample_paths = [Path(f.filepath) for f in frames if Path(f.filepath).exists()]
    if not sample_paths and videos:
        return {
            "suggested_count": min(200, max(50, int(total_duration))),
            "reason": f"基于 {len(videos)} 个视频、总时长 {total_duration:.0f}s，建议抽帧 50-200 张",
        }

    sample = random.choice(sample_paths)
    prompt = f"""这是「{project.name}」项目的样本帧。项目描述：{project.description or '工业视觉检测'}。
任务类型：{project.task_type.value}。
请建议一个合理的训练素材数量（整数），考虑类别数量和场景复杂度。
返回 JSON：{{"suggested_count": int, "reason": "简短中文理由"}}"""

    try:
        result = call_vlm(sample, prompt, project_id=project_id)
        return {
            "suggested_count": int(result.get("suggested_count", 100)),
            "reason": result.get("reason", ""),
        }
    except Exception as e:
        return {
            "suggested_count": min(200, max(50, len(frames) or 100)),
            "reason": f"LLM 不可用，基于当前 {len(frames)} 帧建议: {e}",
        }


def suggest_class_description(image_path: Path, class_name: str, bbox: dict, project_id: str) -> str:
    prompt = f"""用户在图上框选了目标「{class_name}」，框坐标（归一化）: {bbox}。
请用一句中文描述如何标注这类目标（给后续 LLM 标注员使用），要求具体、可执行。
返回 JSON：{{"description": "..."}}"""
    result = call_vlm(image_path, prompt, project_id=project_id)
    return result.get("description", f"框选区域为 {class_name}")
