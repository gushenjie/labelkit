"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { TaskDetailPanel } from "@/components/TaskDetailPanel";
import { Panel, PanelSection } from "@/components/ui/Panel";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { api, Task } from "@/lib/api";
import { formatDateTime } from "@/lib/datetime";
import { Icon } from "@/components/Icon";

const TASK_LABEL: Record<string, string> = {
  extract: "提取素材",
  dedup: "素材去重",
  label: "自动标注",
  review: "自动审查",
  train: "训练模型",
  export: "导出数据",
  relabel: "YOLO 半自动",
  import: "导入数据",
  derive_classify: "生成分类集",
  public_fetch: "公开数据下载分析",
  public_import: "公开数据发布",
};

const STATUS_ZH: Record<string, string> = {
  pending: "等待中",
  running: "进行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  paused: "已暂停",
  interrupted: "已中断",
};

type TaskRow = Task & { projectName: string };

export default function GlobalTasksPage() {
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [selected, setSelected] = useState<TaskRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [filterProject, setFilterProject] = useState("all");
  const [filterStatus, setFilterStatus] = useState("all");

  const load = useCallback(async () => {
    const allTasks = await api.listAllTasks();
    const flat = allTasks.map((task) => ({ ...task, projectName: task.project_name }));
    setTasks(flat);
    setSelected((prev) => (prev ? flat.find((t) => t.id === prev.id) ?? prev : null));
    setLoading(false);
  }, []);

  const projectOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const task of tasks) {
      map.set(task.project_id, task.projectName);
    }
    return [...map.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  }, [tasks]);

  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);

  const filtered = useMemo(() => {
    return tasks.filter((t) => {
      if (filterProject !== "all" && t.project_id !== filterProject) return false;
      if (filterStatus !== "all" && t.status !== filterStatus) return false;
      return true;
    });
  }, [tasks, filterProject, filterStatus]);

  const runningCount = tasks.filter((t) => t.status === "running").length;
  const completedCount = tasks.filter((t) => t.status === "completed").length;
  const failedCount = tasks.filter((t) => t.status === "failed").length;

  return (
    <div className="operations-page task-center-page">
      <section className="operations-summary" aria-label="任务概览">
        <div>
          <span><Icon name="archive" size={17} /></span>
          <strong>{tasks.length}</strong>
          <small>全部任务</small>
        </div>
        <div className={runningCount > 0 ? "operations-summary__active" : ""}>
          <span><Icon name="play" size={17} /></span>
          <strong>{runningCount}</strong>
          <small>正在运行</small>
        </div>
        <div>
          <span><Icon name="check" size={17} /></span>
          <strong>{completedCount}</strong>
          <small>已完成</small>
        </div>
        <div className={failedCount > 0 ? "operations-summary__danger" : ""}>
          <span><Icon name="x" size={17} /></span>
          <strong>{failedCount}</strong>
          <small>执行失败</small>
        </div>
      </section>

      <section className="operations-filterbar">
        <div>
          <Icon name="sliders" size={16} />
          <strong>筛选任务</strong>
        </div>
        <select aria-label="按项目筛选" className="input" value={filterProject} onChange={(e) => setFilterProject(e.target.value)}>
          <option value="all">全部项目</option>
          {projectOptions.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <select aria-label="按状态筛选" className="input" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
          <option value="all">全部状态</option>
          <option value="running">进行中</option>
          <option value="completed">已完成</option>
          <option value="failed">失败</option>
          <option value="cancelled">已取消</option>
          <option value="interrupted">已中断</option>
        </select>
        <span className="operations-filterbar__result">{filtered.length} 条结果</span>
      </section>

      <div className="task-center-layout">
        <Panel className="task-center-list">
          <PanelSection
            title="任务记录"
            action={<span className="panel-section__count">{filtered.length}</span>}
          >
            {loading ? (
              <p className="task-center-empty">加载任务中…</p>
            ) : filtered.length === 0 ? (
              <div className="task-center-empty">
                <span><Icon name="archive" size={20} /></span>
                <strong>没有符合条件的任务</strong>
                <p>调整项目或状态筛选条件后再查看。</p>
              </div>
            ) : (
              <ul className="task-center-items">
                {filtered.map((task) => {
                  const pct = task.total > 0 ? Math.round((task.progress / task.total) * 100) : 0;
                  return (
                    <li key={task.id}>
                      <button
                        type="button"
                        className={selected?.id === task.id ? "task-center-item task-center-item--selected" : "task-center-item"}
                        onClick={() => setSelected(task)}
                      >
                        <span className={`task-center-item__mark task-center-item__mark--${task.status}`}>
                          <Icon name={task.status === "completed" ? "check" : task.status === "failed" ? "x" : "play"} size={14} />
                        </span>
                        <span className="task-center-item__copy">
                          <span>
                            <strong>{TASK_LABEL[task.task_type] || task.task_type}</strong>
                            <StatusBadge status={task.status} label={STATUS_ZH[task.status] || task.status} />
                          </span>
                          <small>{task.projectName}</small>
                          <em>{formatDateTime(task.created_at)} · {task.progress}/{task.total}</em>
                        </span>
                        <span className="task-center-item__progress" aria-label={`进度 ${pct}%`}>
                          <i style={{ width: `${pct}%` }} />
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </PanelSection>
        </Panel>

        <Panel className="task-center-detail">
          <PanelSection title="任务详情">
            {!selected ? (
              <div className="task-detail-placeholder">
                <span><Icon name="list" size={22} /></span>
                <strong>选择一条任务记录</strong>
                <p>这里会显示运行参数、结果摘要和执行日志。</p>
              </div>
            ) : (
              <TaskDetailPanel
                task={selected}
                onCancel={() => api.cancelTask(selected.project_id, selected.id).then(load)}
                onRetry={() => api.retryTask(selected.project_id, selected.id).then(load)}
              />
            )}
          </PanelSection>
        </Panel>
      </div>
    </div>
  );
}
