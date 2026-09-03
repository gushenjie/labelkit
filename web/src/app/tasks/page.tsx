"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { api, type GlobalTask, type ProjectDashboard } from "@/lib/api";

const TASK_LABEL: Record<string, string> = {
  extract: "视频抽帧", dedup: "数据去重", label: "自动标注", review: "标注复查",
  train: "模型训练", export: "数据导出", relabel: "模型重标", import: "数据导入",
  derive_classify: "分类集生成", public_fetch: "公开数据下载", public_import: "公开数据发布",
  dataset_snapshot: "数据版本快照",
};
const STATUS_LABEL: Record<string, string> = {
  pending: "未开始", running: "进行中", paused: "已暂停", completed: "已完成",
  failed: "失败", cancelled: "已取消", interrupted: "已中断",
};
const ASSIGNEES = ["标注助手", "视觉任务进程", "工作区管理员", "自动流水线"];
const PAGE_SIZE_OPTIONS = [5, 10, 15];
const ACTIVE_STATUSES = new Set(["pending", "running", "paused"]);
const POLL_ACTIVE_MS = 2000;
const POLL_IDLE_MS = 8000;
const DASHBOARD_POLL_MS = 20000;

function valueFromParams(task: GlobalTask, key: string) {
  const value = task.params?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}
function taskAssignee(task: GlobalTask) {
  return task.assignee || valueFromParams(task, "assignee") || ASSIGNEES[task.project_id.charCodeAt(0) % ASSIGNEES.length];
}
function taskProgress(task: GlobalTask) {
  if (task.status === "completed") return 100;
  if (task.total <= 0) return task.status === "running" ? 12 : 0;
  return Math.max(0, Math.min(100, Math.round((task.progress / task.total) * 100)));
}
function compactNumber(value: number) {
  return new Intl.NumberFormat("zh-CN").format(value);
}
function shortDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
function dueDate(value: string) {
  const date = new Date(value);
  date.setDate(date.getDate() + 10);
  return shortDate(date.toISOString());
}

export default function GlobalTasksPage() {
  const [tasks, setTasks] = useState<GlobalTask[]>([]);
  const [dashboard, setDashboard] = useState<ProjectDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [taskType, setTaskType] = useState("all");
  const [status, setStatus] = useState("all");
  const [project, setProject] = useState("all");
  const [assignee, setAssignee] = useState("all");
  const [showMore, setShowMore] = useState(false);
  const [view, setView] = useState<"list" | "grid">("list");
  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(1);
  const inflightRef = useRef(false);
  const hasActiveRef = useRef(false);

  const refresh = useCallback(async (mode: "initial" | "silent" | "dashboard" = "silent") => {
    if (mode === "dashboard") {
      try {
        const nextDashboard = await api.getProjectDashboard();
        setDashboard(nextDashboard);
      } catch {
        // 仪表盘刷新失败时保留当前概览
      }
      return;
    }
    if (inflightRef.current) return;
    inflightRef.current = true;
    try {
      if (mode === "initial") {
        const [nextTasks, nextDashboard] = await Promise.all([api.listAllTasks(), api.getProjectDashboard()]);
        setTasks(nextTasks);
        setDashboard(nextDashboard);
        hasActiveRef.current = nextTasks.some((task) => ACTIVE_STATUSES.has(task.status));
        return;
      }
      const nextTasks = await api.listAllTasks();
      setTasks(nextTasks);
      hasActiveRef.current = nextTasks.some((task) => ACTIVE_STATUSES.has(task.status));
    } catch {
      // 静默刷新失败时保留当前列表，避免打断操作
    } finally {
      inflightRef.current = false;
      if (mode === "initial") setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let pollTimer = 0;
    let dashboardTimer = 0;

    const schedulePoll = () => {
      if (cancelled) return;
      const delay = hasActiveRef.current ? POLL_ACTIVE_MS : POLL_IDLE_MS;
      pollTimer = window.setTimeout(async () => {
        if (cancelled) return;
        if (!document.hidden) await refresh("silent");
        schedulePoll();
      }, delay);
    };

    void refresh("initial").then(() => {
      if (!cancelled) schedulePoll();
    });

    dashboardTimer = window.setInterval(() => {
      if (!document.hidden) void refresh("dashboard");
    }, DASHBOARD_POLL_MS);

    const onVisibility = () => {
      if (document.hidden || cancelled) return;
      window.clearTimeout(pollTimer);
      void refresh("silent").then(schedulePoll);
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      window.clearTimeout(pollTimer);
      window.clearInterval(dashboardTimer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh]);

  const projectById = useMemo(
    () => new Map((dashboard?.projects ?? []).map((item) => [item.project.id, item])),
    [dashboard],
  );
  const projectOptions = useMemo(() => {
    const options = new Map(tasks.map((task) => [task.project_id, task.project_name]));
    return [...options.entries()].sort((a, b) => a[1].localeCompare(b[1], "zh-CN"));
  }, [tasks]);
  const typeOptions = useMemo(() => {
    const options = new Map<string, string>();
    for (const task of tasks) {
      options.set(task.task_type, TASK_LABEL[task.task_type] ?? task.task_type);
    }
    return [...options.entries()].sort((a, b) => a[1].localeCompare(b[1], "zh-CN"));
  }, [tasks]);
  const assigneeOptions = useMemo(() => [...new Set(tasks.map(taskAssignee))].sort(), [tasks]);
  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return tasks.filter((task) => {
      if (taskType !== "all" && task.task_type !== taskType) return false;
      if (status !== "all" && task.status !== status) return false;
      if (project !== "all" && task.project_id !== project) return false;
      if (assignee !== "all" && taskAssignee(task) !== assignee) return false;
      if (!normalizedQuery) return true;
      return `${task.id} ${task.project_name} ${TASK_LABEL[task.task_type] ?? task.task_type}`
        .toLowerCase().includes(normalizedQuery);
    });
  }, [assignee, project, query, status, taskType, tasks]);

  useEffect(() => setPage(1), [assignee, pageSize, project, query, status, taskType]);
  useEffect(() => {
    if (!showMore) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target?.closest(".task-more-wrap")) return;
      setShowMore(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [showMore]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const visibleTasks = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);
  const rangeStart = filtered.length ? (safePage - 1) * pageSize + 1 : 0;
  const rangeEnd = Math.min(safePage * pageSize, filtered.length);
  const summary = dashboard?.summary;
  const activeFilterCount = [assignee].filter((value) => value !== "all").length;
  const resetFilters = () => {
    setQuery("");
    setTaskType("all");
    setStatus("all");
    setProject("all");
    setAssignee("all");
  };

  return (
    <div className={`task-center-page task-center-page--${view}`}>
      <section className="task-metrics" aria-label="任务中心概览">
        <Metric icon="folder" value={compactNumber(summary?.total_projects ?? 0)} label="项目总数" trend={`${summary?.projects_last_30_days ?? 0}`} hint="近 30 天" />
        <Metric icon="layers" value={compactNumber(summary?.total_data_items ?? 0)} label="数据总量（项）" trend={compactNumber(summary?.data_items_last_30_days ?? 0)} hint="近 30 天" />
        <Metric icon="users" value={compactNumber(summary?.active_annotators ?? 0)} label="活跃执行者" trend={`${summary?.completed_tasks_last_30_days ?? 0}`} hint="任务已完成" />
        <Metric icon="clock" value={(summary?.total_video_hours ?? 0).toLocaleString("zh-CN", { maximumFractionDigits: 2 })} label="视频总时长" trend={(summary?.video_hours_last_30_days ?? 0).toFixed(2)} hint="近 30 天" />
      </section>

      <section className="task-toolbar" aria-label="任务筛选">
        <label className="task-search"><Icon name="search" size={20} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="按任务 ID、项目或任务类型搜索" /></label>
        <Filter className="task-filter--primary" label="类型" ariaLabel="按类型筛选" value={taskType} onChange={setTaskType} options={[["all", "全部"], ...typeOptions]} />
        <Filter className="task-filter--primary" label="状态" ariaLabel="按状态筛选" value={status} onChange={setStatus} options={[["all", "全部"], ["running", "进行中"], ["completed", "已完成"], ["failed", "失败"], ["pending", "未开始"], ["interrupted", "已中断"], ["cancelled", "已取消"]]} />
        <Filter className="task-filter--primary" label="项目" ariaLabel="按项目筛选" value={project} onChange={setProject} options={[["all", "全部"], ...projectOptions]} />
        <div className="task-more-wrap">
          <button type="button" className={showMore ? "task-more task-more--active" : "task-more"} aria-expanded={showMore} onClick={() => setShowMore((value) => !value)}><Icon name="sliders" size={18} />筛选{activeFilterCount > 0 && <b>{activeFilterCount}</b>}</button>
          {showMore && (
            <div className="task-more-panel" role="dialog" aria-label="更多筛选">
              <div className="task-more-panel__fields">
                <Filter className="task-filter--mobile-only" label="类型" ariaLabel="按类型筛选" value={taskType} onChange={setTaskType} options={[["all", "全部"], ...typeOptions]} />
                <Filter className="task-filter--mobile-only" label="状态" ariaLabel="按状态筛选" value={status} onChange={setStatus} options={[["all", "全部"], ["running", "进行中"], ["completed", "已完成"], ["failed", "失败"], ["pending", "未开始"], ["interrupted", "已中断"], ["cancelled", "已取消"]]} />
                <Filter className="task-filter--mobile-only" label="项目" ariaLabel="按项目筛选" value={project} onChange={setProject} options={[["all", "全部"], ...projectOptions]} />
                <Filter label="执行者" ariaLabel="按执行者筛选" value={assignee} onChange={setAssignee} options={[["all", "全部"], ...assigneeOptions.map((name) => [name, name] as [string, string])]} />
              </div>
              <footer><span>当前显示 {filtered.length} 条任务</span><button type="button" onClick={resetFilters}>重置全部筛选</button></footer>
            </div>
          )}
        </div>
        <div className="task-view-switch" aria-label="视图切换">
          <button type="button" aria-label="列表视图" aria-pressed={view === "list"} className={view === "list" ? "active" : ""} onClick={() => setView("list")}><Icon name="list" size={22} /></button>
          <button type="button" aria-label="网格视图" aria-pressed={view === "grid"} className={view === "grid" ? "active" : ""} onClick={() => setView("grid")}><Icon name="grid" size={20} /></button>
        </div>
      </section>

      <section className="task-results" aria-live="polite">
        {loading ? <div className="task-results__empty">正在加载任务…</div> : visibleTasks.length === 0 ? (
          <div className="task-results__empty"><Icon name="archive" size={28} /><strong>没有符合条件的任务</strong><span>调整筛选条件后再试。</span></div>
        ) : (
          <>
            {view === "list" && (
              <div className="task-list-head" aria-hidden="true">
                <span>任务</span>
                <span>类型</span>
                <span>执行者</span>
                <span>进度</span>
                <span>状态</span>
                <i />
              </div>
            )}
            <div className="task-cards lk-scrollbar">
              {visibleTasks.map((task) => (
                <TaskCard key={task.id} task={task} previewId={projectById.get(task.project_id)?.preview_frame_id ?? null} />
              ))}
            </div>
          </>
        )}
      </section>

      <footer className="task-pagination">
        <span>显示 {rangeStart}–{rangeEnd} 条，共 {filtered.length} 条任务</span>
        <div>
          <label><select aria-label="每页任务数" value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))}>{PAGE_SIZE_OPTIONS.map((value) => <option key={value} value={value}>{value} 条 / 页</option>)}</select><Icon name="chevron-down" size={15} /></label>
          <button type="button" aria-label="上一页" disabled={safePage === 1} onClick={() => setPage((value) => Math.max(1, value - 1))}><Icon name="chevron-left" size={17} /></button>
          {Array.from({ length: Math.min(pageCount, 3) }, (_, index) => index + 1).map((value) => <button type="button" key={value} className={safePage === value ? "active" : ""} onClick={() => setPage(value)}>{value}</button>)}
          {pageCount > 4 && <span>…</span>}
          {pageCount > 3 && <button type="button" className={safePage === pageCount ? "active" : ""} onClick={() => setPage(pageCount)}>{pageCount}</button>}
          <button type="button" aria-label="下一页" disabled={safePage === pageCount} onClick={() => setPage((value) => Math.min(pageCount, value + 1))}><Icon name="chevron-right" size={17} /></button>
        </div>
      </footer>
    </div>
  );
}

function Metric({ icon, value, label, trend, hint }: { icon: "folder" | "layers" | "users" | "clock"; value: string; label: string; trend: string; hint: string }) {
  return <article><span className="task-metric__icon"><Icon name={icon} size={28} /></span><div><strong>{value}</strong><p>{label}</p><small>↑ {trend} <em>{hint}</em></small></div></article>;
}

function Filter({ className = "", label, ariaLabel, value, onChange, options }: { className?: string; label: string; ariaLabel: string; value: string; onChange: (value: string) => void; options: [string, string][] }) {
  return <label className={`task-filter ${className}`.trim()}><span>{label}</span><select aria-label={ariaLabel} value={value} onChange={(event) => onChange(event.target.value)}>{options.map(([optionValue, optionLabel]) => <option key={optionValue} value={optionValue}>{optionLabel}</option>)}</select><Icon name="chevron-down" size={15} /></label>;
}

function TaskCard({ task, previewId }: { task: GlobalTask; previewId: string | null }) {
  const progress = taskProgress(task);
  const assigned = taskAssignee(task);
  const taskCode = `TASK-${task.id.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
  const typeLabel = TASK_LABEL[task.task_type] ?? task.task_type;
  return (
    <article className="task-card">
      <Link href={`/projects/${task.project_id}/tasks`} className="task-card__media" aria-label={`打开 ${taskCode}`}>
        {previewId ? <img src={api.frameImageUrl(task.project_id, previewId)} alt="" /> : <span><Icon name="image" size={25} /></span>}
      </Link>
      <div className="task-card__identity">
        <div className="task-card__title">
          <Link href={`/projects/${task.project_id}/tasks`}>{taskCode}</Link>
          <button type="button" title="复制任务 ID" aria-label={`复制 ${taskCode}`} onClick={() => navigator.clipboard?.writeText(task.id)}>⧉</button>
        </div>
        <span className="task-card__project">{task.project_name}</span>
        <div className="task-card__dates">
          <span><Icon name="audit" size={14} />创建：{shortDate(task.created_at)}</span>
          <span><Icon name="audit" size={14} />截止：{dueDate(task.created_at)}</span>
        </div>
      </div>
      <div className="task-card__type">
        <small>类型</small>
        <span>{typeLabel}</span>
      </div>
      <div className="task-card__assignee">
        <small>执行者</small>
        <span><i>{assigned.slice(0, 1).toUpperCase()}</i>{assigned}</span>
      </div>
      <div className="task-card__progress">
        <small>进度</small>
        <div>
          <span><i style={{ width: `${progress}%` }} /></span>
          <strong>{progress}%</strong>
        </div>
        <p>{compactNumber(task.progress)} / {compactNumber(task.total)}</p>
      </div>
      <div className="task-card__state">
        <small>状态</small>
        <span className={`task-status task-status--${task.status}`}>{STATUS_LABEL[task.status] ?? task.status}</span>
      </div>
      <div className="task-card__mobile-summary">
        <span className={`task-status task-status--${task.status}`}>{STATUS_LABEL[task.status] ?? task.status}</span>
        <span className="task-card__mobile-progress"><i><b style={{ width: `${progress}%` }} /></i><strong>{progress}%</strong></span>
        <span className="task-card__mobile-type">{typeLabel}</span>
        <span className="task-card__mobile-assignee">{assigned}</span>
      </div>
      <button type="button" className="task-card__menu" aria-label={`${taskCode} 更多操作`} title={task.error || task.log || "更多操作"}>
        <Icon name="more" size={20} />
      </button>
    </article>
  );
}
