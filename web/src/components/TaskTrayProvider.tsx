"use client";

import Link from "next/link";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api, type Task } from "@/lib/api";
import { getNextActionForTask, taskTypeLabel } from "@/lib/workflow";
import { TASK_STATUS_ZH } from "@/lib/status";
import { useToast } from "@/components/ui/ToastProvider";

export type TaskRow = Task & { projectName: string };

type TaskTrayContextValue = {
  runningTasks: TaskRow[];
  recentTasks: TaskRow[];
  refresh: () => Promise<void>;
};

const TaskTrayContext = createContext<TaskTrayContextValue | null>(null);

export function TaskTrayProvider({ children }: { children: React.ReactNode }) {
  const { toast } = useToast();
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const prevStatusRef = useRef<Map<string, string>>(new Map());

  const refresh = useCallback(async () => {
    const list = await api.listProjects();
    const rows = await Promise.all(
      list.map(async (p) => {
        const ts = await api.listTasks(p.id);
        return ts.map((t) => ({ ...t, projectName: p.name }));
      }),
    );
    const flat = rows
      .flat()
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    setTasks(flat);

    for (const t of flat) {
      const key = t.id;
      const prev = prevStatusRef.current.get(key);
      if (prev === "running" && t.status === "completed") {
        const next = getNextActionForTask(t.project_id, t.task_type);
        let message = `${taskTypeLabel(t.task_type)}完成`;
        if (t.task_type === "extract" && t.result?.kept) {
          message = `提取完成 · ${t.result.kept} 张`;
        } else if (t.task_type === "label" && t.result?.ok) {
          message = `标注完成 · ${t.result.ok} 张`;
        } else if (t.task_type === "train" && t.result?.version) {
          message = `训练完成 · v${t.result.version}`;
        } else if (t.task_type === "export" && t.result?.stats) {
          const s = t.result.stats as { train?: number; val?: number };
          message = `导出完成 · 训练 ${s.train ?? 0} / 验证 ${s.val ?? 0}`;
        }
        toast({
          type: "success",
          message,
          action: next ? { label: next.label, href: next.href } : undefined,
          duration: 8000,
        });
        if (t.task_type === "export" && t.result?.path) {
          api.openPath(String(t.result.path)).catch(() => {});
        }
      }
      if (prev === "running" && t.status === "failed") {
        toast({
          type: "error",
          message: `${taskTypeLabel(t.task_type)}失败：${t.error || "未知错误"}`,
          duration: 8000,
        });
      }
      prevStatusRef.current.set(key, t.status);
    }
  }, [toast]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [refresh]);

  const runningTasks = useMemo(
    () => tasks.filter((t) => t.status === "running" || t.status === "pending"),
    [tasks],
  );
  const recentTasks = useMemo(() => tasks.slice(0, 8), [tasks]);

  const value = useMemo(
    () => ({ runningTasks, recentTasks, refresh }),
    [runningTasks, recentTasks, refresh],
  );

  return (
    <TaskTrayContext.Provider value={value}>
      {children}
    </TaskTrayContext.Provider>
  );
}

export function TaskTrayWidget() {
  const { runningTasks, recentTasks } = useTaskTray();
  const [panelOpen, setPanelOpen] = useState(false);
  const primaryRunning = runningTasks[0];

  return (
    <div className="task-tray">
        <button
          type="button"
          className={`task-tray__trigger ${runningTasks.length > 0 ? "task-tray__trigger--active" : ""}`}
          onClick={() => setPanelOpen((v) => !v)}
          aria-expanded={panelOpen}
          aria-label="任务进度"
        >
          {primaryRunning ? (
            <>
              <span className="task-tray__dot" aria-hidden="true" />
              <span className="task-tray__text">
                {taskTypeLabel(primaryRunning.task_type)} {primaryRunning.progress}/{primaryRunning.total}
              </span>
            </>
          ) : (
            <span className="task-tray__text">任务</span>
          )}
        </button>
        {panelOpen && (
          <>
            <button
              type="button"
              className="task-tray__backdrop"
              aria-label="关闭任务面板"
              onClick={() => setPanelOpen(false)}
            />
            <div className="task-tray__panel">
              <div className="task-tray__header">
                <h3>后台任务</h3>
                <Link href="/tasks" className="task-tray__link" onClick={() => setPanelOpen(false)}>
                  任务中心 →
                </Link>
              </div>
              {runningTasks.length === 0 ? (
                <p className="task-tray__empty">当前没有进行中的任务</p>
              ) : (
                <ul className="task-tray__list">
                  {runningTasks.map((t) => {
                    const pct = t.total > 0 ? Math.round((t.progress / t.total) * 100) : 0;
                    return (
                      <li key={t.id} className="task-tray__item">
                        <div className="task-tray__item-head">
                          <span>{taskTypeLabel(t.task_type)}</span>
                          <span>{t.progress}/{t.total}</span>
                        </div>
                        <p className="task-tray__project">{t.projectName}</p>
                        <div className="task-tray__bar">
                          <div className="task-tray__bar-fill" style={{ width: `${pct}%` }} />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
              {recentTasks.length > 0 && (
                <div className="task-tray__recent">
                  <p className="task-tray__recent-title">最近</p>
                  <ul>
                    {recentTasks.slice(0, 4).map((t) => (
                      <li key={t.id}>
                        <span>{taskTypeLabel(t.task_type)}</span>
                        <span className="task-tray__status">
                          {t.cancel_requested && t.status === "running"
                            ? "取消中"
                            : (TASK_STATUS_ZH[t.status] ?? t.status)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </>
        )}
      </div>
  );
}

export function useTaskTray() {
  const ctx = useContext(TaskTrayContext);
  if (!ctx) throw new Error("useTaskTray must be used within TaskTrayProvider");
  return ctx;
}
