"""Local system utilities (folder picker, etc.)."""

from __future__ import annotations

import platform
import subprocess
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/api/system", tags=["system"])


class OpenPathRequest(BaseModel):
    path: str


@router.post("/pick-folder")
def pick_folder():
    """macOS：弹出系统文件夹选择对话框，返回绝对路径。"""
    if platform.system() != "Darwin":
        raise HTTPException(400, "当前仅支持 macOS 文件夹选择，请手动填写路径")

    script = 'POSIX path of (choose folder with prompt "选择数据集导出目录")'
    try:
        proc = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True,
            text=True,
            timeout=120,
        )
    except subprocess.TimeoutExpired:
        raise HTTPException(408, "选择文件夹超时") from None

    if proc.returncode != 0:
        raise HTTPException(400, "未选择文件夹")

    path = proc.stdout.strip()
    if not path:
        raise HTTPException(400, "未选择文件夹")
    return {"path": path}


@router.post("/open-path")
def open_path(body: OpenPathRequest):
    """在系统默认文件管理器中打开目录。"""
    raw = body.path.strip()
    if not raw:
        raise HTTPException(400, "路径不能为空")

    path = Path(raw).expanduser().resolve()
    if not path.exists():
        raise HTTPException(404, f"路径不存在: {path}")
    if not path.is_dir():
        raise HTTPException(400, "只能打开目录")

    try:
        system = platform.system()
        if system == "Darwin":
            subprocess.run(["open", str(path)], check=True)
        elif system == "Windows":
            subprocess.run(["explorer", str(path)], check=True)
        else:
            subprocess.run(["xdg-open", str(path)], check=True)
    except subprocess.CalledProcessError as e:
        raise HTTPException(500, f"无法打开目录: {e}") from e

    return {"ok": True, "path": str(path)}
