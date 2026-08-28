"""Local system utilities (folder picker, etc.)."""

from __future__ import annotations

import platform
import shutil
import subprocess
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/api/system", tags=["system"])


class OpenPathRequest(BaseModel):
    path: str


@router.post("/pick-folder")
def pick_folder():
    """Open a native folder chooser where the platform provides one."""
    system = platform.system()
    if system == "Darwin":
        command = ["osascript", "-e", 'POSIX path of (choose folder with prompt "选择数据集导出目录")']
    elif system == "Windows":
        command = [
            "powershell",
            "-NoProfile",
            "-STA",
            "-Command",
            (
                "$shell = New-Object -ComObject Shell.Application; "
                "$folder = $shell.BrowseForFolder(0, '选择数据集导出目录', 0); "
                "if ($folder) { $folder.Self.Path }"
            ),
        ]
    elif shutil.which("zenity"):
        command = ["zenity", "--file-selection", "--directory", "--title=选择数据集导出目录"]
    else:
        raise HTTPException(400, "未检测到可用的目录选择器，请手动填写绝对路径")
    try:
        proc = subprocess.run(
            command,
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
