"""训练子进程生命周期：PID 登记、孤儿识别与终止。

保证任务状态与机器上的 train_entry 进程事实一致：
API 进程退出/重启时，不得留下「库里已中断、GPU 仍在训」的孤儿。
"""

from __future__ import annotations

import threading
from pathlib import Path

from server.core.paths import exports_dir

_lock = threading.Lock()
_active_pids: set[int] = set()


def terminate_process_tree(pid: int, timeout: float = 5.0) -> None:
    import psutil

    try:
        parent = psutil.Process(pid)
    except psutil.NoSuchProcess:
        return
    processes = parent.children(recursive=True) + [parent]
    for process in processes:
        try:
            process.terminate()
        except psutil.NoSuchProcess:
            pass
    _, alive = psutil.wait_procs(processes, timeout=timeout)
    for process in alive:
        try:
            process.kill()
        except psutil.NoSuchProcess:
            pass
    psutil.wait_procs(alive, timeout=timeout)


def training_pid_path(project_id: str, task_id: str) -> Path:
    return exports_dir(project_id) / "training_runs" / f"task_{task_id}.pid"


def register_train_pid(pid: int) -> None:
    with _lock:
        _active_pids.add(int(pid))


def unregister_train_pid(pid: int | None) -> None:
    if pid is None:
        return
    with _lock:
        _active_pids.discard(int(pid))


def write_train_pid(project_id: str, task_id: str, pid: int) -> Path:
    path = training_pid_path(project_id, task_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(str(int(pid)), encoding="utf-8")
    register_train_pid(pid)
    return path


def clear_train_pid(project_id: str, task_id: str, pid: int | None = None) -> None:
    path = training_pid_path(project_id, task_id)
    if path.exists():
        try:
            path.unlink()
        except OSError:
            pass
    unregister_train_pid(pid)


def read_train_pid(project_id: str, task_id: str) -> int | None:
    path = training_pid_path(project_id, task_id)
    if not path.is_file():
        return None
    try:
        value = int(path.read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        return None
    return value if value > 0 else None


def find_train_pids_for_task(task_id: str) -> list[int]:
    """按命令行定位仍在运行的 train_entry（兼容无 pid 文件的旧孤儿）。"""
    import psutil

    needles = (
        f"training-request-{task_id}.json",
        f"training-{task_id}.log",
    )
    found: list[int] = []
    for process in psutil.process_iter(["pid", "cmdline"]):
        try:
            cmdline = process.info.get("cmdline") or []
            text = " ".join(str(part) for part in cmdline)
        except (psutil.Error, TypeError):
            continue
        if "server.core.train_entry" not in text and "train_entry" not in text:
            continue
        if any(needle in text for needle in needles):
            found.append(int(process.info["pid"]))
    return found


def is_pid_alive(pid: int) -> bool:
    import psutil

    try:
        return psutil.Process(int(pid)).is_running()
    except psutil.Error:
        return False


def terminate_train_pids(pids: list[int], *, timeout: float = 5.0) -> list[int]:
    """终止给定 PID 及其子进程树，返回实际尝试终止的 PID。"""
    terminated: list[int] = []
    seen: set[int] = set()
    for pid in pids:
        value = int(pid)
        if value in seen:
            continue
        seen.add(value)
        if not is_pid_alive(value):
            unregister_train_pid(value)
            continue
        terminate_process_tree(value, timeout=timeout)
        unregister_train_pid(value)
        terminated.append(value)
    return terminated


def cleanup_task_train_processes(project_id: str, task_id: str) -> list[int]:
    """清理某任务相关的训练进程（pid 文件 + 命令行扫描）。"""
    pids = set(find_train_pids_for_task(task_id))
    recorded = read_train_pid(project_id, task_id)
    if recorded:
        pids.add(recorded)
    terminated = terminate_train_pids(sorted(pids))
    clear_train_pid(project_id, task_id, recorded)
    return terminated


def cleanup_all_registered_trains() -> list[int]:
    with _lock:
        pids = sorted(_active_pids)
    return terminate_train_pids(pids)
