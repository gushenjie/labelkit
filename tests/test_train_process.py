"""训练进程生命周期辅助测试。"""

from __future__ import annotations

import sys
import types

from server.core.train_process import clear_train_pid, find_train_pids_for_task, read_train_pid, write_train_pid


def test_write_and_read_train_pid(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "server.core.train_process.exports_dir",
        lambda project_id: tmp_path / project_id / "exports",
    )
    path = write_train_pid("p1", "task-1", 43210)
    assert path.exists()
    assert read_train_pid("p1", "task-1") == 43210
    clear_train_pid("p1", "task-1", 43210)
    assert read_train_pid("p1", "task-1") is None


def test_find_train_pids_matches_request_file(monkeypatch):
    class FakeProc:
        def __init__(self, pid: int, cmdline: list[str]):
            self.info = {"pid": pid, "cmdline": cmdline}

    procs = [
        FakeProc(11, ["python", "-m", "server.core.train_entry", "--params", r"D:\x\training-request-abc.json"]),
        FakeProc(22, ["python", "-m", "other"]),
        FakeProc(33, ["python", "-m", "server.core.train_entry", "--params", r"D:\x\training-request-zzz.json"]),
    ]
    fake_psutil = types.SimpleNamespace(
        Error=Exception,
        process_iter=lambda _attrs: procs,
    )
    monkeypatch.setitem(sys.modules, "psutil", fake_psutil)
    assert find_train_pids_for_task("abc") == [11]
    assert find_train_pids_for_task("zzz") == [33]
    assert find_train_pids_for_task("missing") == []
