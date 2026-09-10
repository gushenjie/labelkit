"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/Icon";
import { ResumeTrainDialog, type ResumeTrainParams } from "@/components/ResumeTrainDialog";
import { TrainLogPanel } from "@/components/TrainLogPanel";
import { ListSkeleton } from "@/components/ui/ListSkeleton";
import { Select } from "@/components/ui/Select";
import { useToast } from "@/components/ui/ToastProvider";
import { api, type GlobalTask, type ProjectDashboard } from "@/lib/api";
import { formatTrainLog } from "@/lib/train-log";
import { ChangedValue, ModalSurface } from "@/components/ui/motion";
import { useTaskLayout } from "@/components/ui/useTaskLayout";
import { useExitItems } from "@/components/ui/useExitItems";

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
  if (task.total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((task.progress / task.total) * 100)));
}
function compactNumber(value: number) {
  return new Intl.NumberFormat("zh-CN").format(value);
}
function shortDateTime(value?: string | null) {
  if (!value) return "--";
  const raw = value.trim();
  const normalized = /[zZ]|[+-]\d{2}:\d{2}$/.test(raw) ? raw : `${raw}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return "--";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}
function taskCodeOf(taskId: string) {
  return `TASK-${taskId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
}

export default function GlobalTasksPage() {
  const { toast } = useToast();
  const [tasks, setTasks] = useState<GlobalTask[]>([]);
  const [dashboard, setDashboard] = useState<ProjectDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [refreshError, setRefreshError] = useState(false);
  const [query, setQuery] = useState("");
  const [taskType, setTaskType] = useState("all");
  const [status, setStatus] = useState("all");
  const [project, setProject] = useState("all");
  const [assignee, setAssignee] = useState("all");
  const [showMore, setShowMore] = useState(false);
  const [view, setView] = useState<"list" | "grid">("list");
  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(1);
  const [resumingId, setResumingId] = useState<string | null>(null);
  const [resumeTaskId, setResumeTaskId] = useState<string | null>(null);
  const [logTaskId, setLogTaskId] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const inflightRef = useRef(false);
  const hasActiveRef = useRef(false);

  useEffect(() => {
    setMounted(true);
  }, []);

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
    if (mode === "initial") { setLoading(true); setLoadError(false); }
    try {
      if (mode === "initial") {
        const [nextTasks, nextDashboard] = await Promise.all([api.listAllTasks(), api.getProjectDashboard()]);
        setTasks(nextTasks);
        setDashboard(nextDashboard);
        hasActiveRef.current = nextTasks.some((task) => ACTIVE_STATUSES.has(task.status));
        setRefreshError(false);
        return;
      }
      const nextTasks = await api.listAllTasks();
      setTasks(nextTasks);
      hasActiveRef.current = nextTasks.some((task) => ACTIVE_STATUSES.has(task.status));
      setRefreshError(false);
    } catch {
      if (mode === "initial") setLoadError(true);
      else setRefreshError(true);
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
  const visibleTasks = useMemo(() => filtered.slice((safePage - 1) * pageSize, safePage * pageSize), [filtered, safePage, pageSize]);
  const resultKey = [query, taskType, status, project, assignee, safePage, pageSize].join("|");
  const taskLayout = useTaskLayout(view, `${resultKey}|${visibleTasks.map(task => task.id).join(",")}`);
  const changeView = (next: "list" | "grid") => { if (next !== view) { taskLayout.capture(); setView(next); } };
  const displayedTasks = useExitItems(visibleTasks, resultKey);
  useEffect(() => {
    const focused = document.activeElement?.closest<HTMLElement>("[data-task-id]");
    if (focused?.hasAttribute("inert")) taskLayout.ref.current?.focus();
  }, [displayedTasks, taskLayout.ref]);
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

  const openResume = (task: GlobalTask) => {
    if (!task.can_resume) return;
    setResumeTaskId(task.id);
  };

  const resumeTask = useMemo(
    () => (resumeTaskId ? tasks.find((item) => item.id === resumeTaskId) ?? null : null),
    [resumeTaskId, tasks],
  );

  const confirmResume = async (params: ResumeTrainParams) => {
    if (!resumeTask) return;
    setResumingId(resumeTask.id);
    try {
      await api.resumeTrainTask(resumeTask.project_id, resumeTask.id, params);
      toast({ type: "success", message: "已启动断点续训" });
      setResumeTaskId(null);
      await refresh("silent");
    } catch (error) {
      toast({ type: "error", message: `续训失败：${error}` });
    } finally {
      setResumingId(null);
    }
  };

  const logTask = useMemo(
    () => (logTaskId ? tasks.find((item) => item.id === logTaskId) ?? null : null),
    [logTaskId, tasks],
  );
  const trainLogLines = useMemo(() => formatTrainLog(logTask?.log ?? ""), [logTask?.log]);

  const copyTrainLog = async () => {
    if (!trainLogLines.length) return;
    try {
      await navigator.clipboard.writeText(trainLogLines.join("\n"));
      toast({ type: "success", message: "训练日志已复制" });
    } catch {
      toast({ type: "error", message: "复制失败，请检查剪贴板权限" });
    }
  };

  return (
    <div className={`task-center-page task-center-page--${view}`}>
      <section className="task-metrics" aria-label="任务中心概览">
        <Metric loading={!summary} icon="folder" value={compactNumber(summary?.total_projects ?? 0)} label="项目总数" trend={`${summary?.projects_last_30_days ?? 0}`} hint="近 30 天" />
        <Metric loading={!summary} icon="layers" value={compactNumber(summary?.total_data_items ?? 0)} label="数据总量（项）" trend={compactNumber(summary?.data_items_last_30_days ?? 0)} hint="近 30 天" />
        <Metric loading={!summary} icon="users" value={compactNumber(summary?.active_annotators ?? 0)} label="活跃执行者" trend={`${summary?.completed_tasks_last_30_days ?? 0}`} hint="任务已完成" />
        <Metric loading={!summary} icon="clock" value={(summary?.total_video_hours ?? 0).toLocaleString("zh-CN", { maximumFractionDigits: 2 })} label="视频总时长" trend={(summary?.video_hours_last_30_days ?? 0).toFixed(2)} hint="近 30 天" />
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
          <button type="button" aria-label="列表视图" aria-pressed={view === "list"} className={view === "list" ? "active" : ""} onClick={() => changeView("list")}><Icon name="list" size={22} /></button>
          <button type="button" aria-label="网格视图" aria-pressed={view === "grid"} className={view === "grid" ? "active" : ""} onClick={() => changeView("grid")}><Icon name="grid" size={20} /></button>
        </div>
      </section>

      {refreshError && <div role="status" className="task-refresh-error">刷新失败，当前显示上次数据。<button type="button" onClick={() => void refresh("silent")}>重试</button></div>}
      <section className="task-results" aria-busy={loading}>
        {view === "list" && (loading || visibleTasks.length > 0) && (
          <div className="task-list-head" aria-hidden="true">
            <span>任务</span>
            <span>类型</span>
            <span>执行者</span>
            <span>时间</span>
            <span>进度</span>
            <span>状态</span>
            <span>操作</span>
          </div>
        )}
        {loading ? (
          <ListSkeleton
            className="task-list-skeleton lk-scrollbar"
            variant={view}
            count={view === "grid" ? 8 : 6}
            fields={3}
            label="正在加载任务列表"
          />
        ) : loadError ? (
          <div className="task-results__empty" role="alert"><strong>任务加载失败</strong><button type="button" className="btn-secondary" onClick={() => void refresh("initial")}>重新加载</button></div>
        ) : displayedTasks.length === 0 ? (
          <div className="task-results__empty"><Icon name="archive" size={28} /><strong>没有符合条件的任务</strong><span>调整筛选条件后再试。</span></div>
        ) : (
          <div className="task-cards lk-scrollbar" ref={taskLayout.ref} tabIndex={-1} aria-label="任务列表">
            {displayedTasks.map(({ item: task, exiting }, index) => (
              <TaskCard
                key={task.id}
                task={task}
                previewId={projectById.get(task.project_id)?.preview_frame_id ?? null}
                animationIndex={index}
                exiting={exiting}
                resuming={resumingId === task.id}
                onResume={openResume}
                onViewLog={() => setLogTaskId(task.id)}
              />
            ))}
          </div>
        )}
      </section>

      <footer className={loading ? "task-pagination task-pagination--loading" : "task-pagination"} aria-hidden={loading}>
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

      {mounted && createPortal(
        <ModalSurface open={Boolean(logTask)} onClose={() => setLogTaskId(null)}>
        {logTask && (
          <div
            className="materials-public-import-dialog task-train-log-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="task-train-log-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="materials-public-import-dialog__head">
              <div>
                <h2 id="task-train-log-title">训练日志</h2>
                <p>
                  {`TASK-${logTask.id.replaceAll("-", "").slice(0, 6).toUpperCase()}`}
                  {" · "}
                  {logTask.project_name}
                  {" · "}
                  {STATUS_LABEL[logTask.status] ?? logTask.status}
                  {" · "}
                  {logTask.progress}/{logTask.total || "?"}
                  {logTask.resume_from_task_id
                    ? ` · 续训自 ${taskCodeOf(logTask.resume_from_task_id)}`
                    : ""}
                </p>
              </div>
              <button
                type="button"
                className="modal-close-button"
                aria-label="关闭"
                onClick={() => setLogTaskId(null)}
              >
                <Icon name="x" size={18} />
              </button>
            </header>
            <div className="materials-public-import-dialog__body task-train-log-dialog__body">
              <div className="train-monitor__log-wrap task-train-log-dialog__panel">
                <div className="train-monitor__head">
                  <h3>训练日志</h3>
                  <div className="train-monitor__head-actions">
                    <span className="train-monitor__status">{trainLogLines.length} 行</span>
                    <button
                      type="button"
                      className="btn-secondary train-monitor__copy-button"
                      disabled={!trainLogLines.length}
                      onClick={() => void copyTrainLog()}
                      title="复制当前显示的训练日志"
                    >
                      <Icon name="copy" size={14} />
                      一键复制
                    </button>
                  </div>
                </div>
                <TrainLogPanel
                  lines={trainLogLines}
                  emptyText={logTask.status === "running" ? "等待训练输出…" : "暂无训练日志"}
                />
              </div>
            </div>
            <footer className="materials-public-import-dialog__footer">
              {logTask.can_resume ? (
                <button
                  type="button"
                  className="btn-primary"
                  disabled={resumingId === logTask.id}
                  onClick={() => {
                    setLogTaskId(null);
                    openResume(logTask);
                  }}
                >
                  继续训练
                </button>
              ) : null}
              <button type="button" className="btn-secondary" onClick={() => setLogTaskId(null)}>
                关闭
              </button>
            </footer>
          </div>
        )}
        </ModalSurface>,
        document.body,
      )}

      <ResumeTrainDialog
        open={Boolean(resumeTask)}
        task={resumeTask}
        submitting={Boolean(resumeTask && resumingId === resumeTask.id)}
        onClose={() => {
          if (resumingId) return;
          setResumeTaskId(null);
        }}
        onConfirm={(params) => void confirmResume(params)}
      />
    </div>
  );
}

function Metric({ icon, value, label, trend, hint, loading = false }: { icon: "folder" | "layers" | "users" | "clock"; value: string; label: string; trend: string; hint: string; loading?: boolean }) {
  return <article><span className="task-metric__icon"><Icon name={icon} size={30} /></span><div><strong>{loading ? <span className="lk-value-placeholder" aria-label="加载中" /> : <ChangedValue value={value} />}</strong><p>{label}</p><small style={{ visibility: loading ? "hidden" : undefined }}>↑ <ChangedValue value={trend} /> <em>{hint}</em></small></div></article>;
}

function Filter({ className = "", label, ariaLabel, value, onChange, options }: { className?: string; label: string; ariaLabel: string; value: string; onChange: (value: string) => void; options: [string, string][] }) {
  return <Select className={`task-filter ${className}`.trim()} leadingLabel={label} ariaLabel={ariaLabel} value={value} onValueChange={onChange} options={options.map(([optionValue, optionLabel]) => ({ value: optionValue, label: optionLabel }))} />;
}

function TaskCard({
  task,
  previewId,
  animationIndex,
  resuming,
  onResume,
  onViewLog,
  exiting = false,
}: {
  task: GlobalTask;
  previewId: string | null;
  animationIndex: number;
  resuming: boolean;
  onResume: (task: GlobalTask) => void;
  onViewLog: () => void;
  exiting?: boolean;
}) {
  const progress = taskProgress(task);
  const assigned = taskAssignee(task);
  const taskCode = taskCodeOf(task.id);
  const typeLabel = TASK_LABEL[task.task_type] ?? task.task_type;
  const isTrain = task.task_type === "train";
  const canResume = Boolean(task.can_resume);
  const resumeFromId = task.resume_from_task_id || null;
  const latestResumeId = task.latest_resume_task_id || null;
  return (
    <article
      className="task-card"
      data-status={task.status}
      data-task-id={task.id}
      data-exiting={exiting || undefined}
      inert={exiting}
      aria-hidden={exiting || undefined}
      style={{ "--task-index": animationIndex } as CSSProperties}
    >
      <Link href={`/projects/${task.project_id}/tasks`} className="task-card__media" aria-label={`打开 ${taskCode}`}>
        {previewId ? <img src={api.frameImageUrl(task.project_id, previewId)} alt="" /> : <span><Icon name="image" size={25} /></span>}
      </Link>
      <div className="task-card__identity">
        <div className="task-card__title">
          <Link href={`/projects/${task.project_id}/tasks`}>{taskCode}</Link>
          <button type="button" title="复制任务 ID" aria-label={`复制 ${taskCode}`} onClick={() => navigator.clipboard?.writeText(task.id)}>⧉</button>
        </div>
        <div className="task-card__meta">
          <span className="task-card__project">{task.project_name}</span>
          {resumeFromId ? (
            <span className="task-card__lineage" title={`从 ${taskCodeOf(resumeFromId)} 断点续训`}>
              续训自 {taskCodeOf(resumeFromId)}
            </span>
          ) : null}
          {!resumeFromId && latestResumeId ? (
            <span className="task-card__lineage task-card__lineage--muted" title={`最近续训尝试 ${taskCodeOf(latestResumeId)}`}>
              已续训 {taskCodeOf(latestResumeId)}
            </span>
          ) : null}
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
      <div className="task-card__time">
        <small>时间</small>
        <span title={task.started_at || undefined}>开始 {shortDateTime(task.started_at)}</span>
        <span title={task.finished_at || undefined}>结束 {shortDateTime(task.finished_at)}</span>
      </div>
      <div className="task-card__progress">
        <small>进度</small>
        <div>
          <span><i style={{ width: `${progress}%` }} /></span>
          <strong><ChangedValue value={task.total <= 0 && task.status !== "completed" ? "—" : `${progress}%`} /></strong>
        </div>
        <p>{compactNumber(task.progress)} / {compactNumber(task.total)}</p>
      </div>
      <div className="task-card__state">
        <small>状态</small>
        <span className={`task-status task-status--${task.status}`}><ChangedValue value={STATUS_LABEL[task.status] ?? task.status} /></span>
      </div>
      <div className="task-card__actions">
        {canResume ? (
          <button
            type="button"
            className="task-card__action task-card__action--resume"
            disabled={resuming}
            title={`从 ${task.progress}/${task.total || "?"} 断点继续`}
            onClick={() => onResume(task)}
          >
            <span className="task-card__action-ico" aria-hidden="true">
              <Icon name="play" size={11} />
            </span>
            {resuming ? "启动中" : "继续训练"}
          </button>
        ) : null}
        {isTrain ? (
          <button
            type="button"
            className="task-card__action task-card__action--log"
            title="查看训练日志"
            onClick={onViewLog}
          >
            <Icon name="list" size={13} />
            查看日志
          </button>
        ) : null}
      </div>
      <div className="task-card__mobile-summary">
        <span className={`task-status task-status--${task.status}`}><ChangedValue value={STATUS_LABEL[task.status] ?? task.status} /></span>
        <span className="task-card__mobile-progress"><i><b style={{ width: `${progress}%` }} /></i><strong><ChangedValue value={task.total <= 0 && task.status !== "completed" ? "—" : `${progress}%`} /></strong></span>
        <span className="task-card__mobile-type">{typeLabel}</span>
        <span className="task-card__mobile-assignee">{assigned}</span>
        <span className="task-card__mobile-time">
          开始 {shortDateTime(task.started_at)} · 结束 {shortDateTime(task.finished_at)}
        </span>
        <div className="task-card__mobile-actions">
          {canResume ? (
            <button
              type="button"
              className="task-card__action task-card__action--resume"
              disabled={resuming}
              onClick={() => onResume(task)}
            >
              <span className="task-card__action-ico" aria-hidden="true">
                <Icon name="play" size={11} />
              </span>
              {resuming ? "启动中" : "继续训练"}
            </button>
          ) : null}
          {isTrain ? (
            <button type="button" className="task-card__action task-card__action--log" onClick={onViewLog}>
              <Icon name="list" size={13} />
              查看日志
            </button>
          ) : null}
        </div>
      </div>
    </article>
  );
}
