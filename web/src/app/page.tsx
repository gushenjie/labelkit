"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CreateProjectModal } from "@/components/CreateProjectModal";
import { Icon } from "@/components/Icon";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/ToastProvider";
import { api, type Project, type ProjectDashboard, type ProjectOverview } from "@/lib/api";
import { countBlockingReview, countConfirmed, countTrainable } from "@/lib/status";
import { computeContinueAction, computeStepBadges, WORKFLOW_STEPS, type WorkflowStep } from "@/lib/workflow";
import "./project-management.css";

type StatusFilter = "all" | "active" | "deployment" | "attention";
type StageFilter = "all" | WorkflowStep;
type ViewMode = "list" | "grid";
type TaskTypeFilter = "all" | "detect" | "classify";
type SortFilter = "recent" | "name" | "size";

const DEFAULT_PROJECT_COVER = "/project-art/default-project-cover.png";

const STEPS = WORKFLOW_STEPS;

const EMPTY_DASHBOARD: ProjectDashboard = {
  summary: {
    total_projects: 0,
    total_data_items: 0,
    active_annotators: 0,
    total_video_hours: 0,
    projects_last_30_days: 0,
    data_items_last_30_days: 0,
    completed_tasks_last_30_days: 0,
    video_hours_last_30_days: 0,
  },
  projects: [],
};

function formatNumber(value: number) {
  return new Intl.NumberFormat("zh-CN").format(value || 0);
}

function formatHours(value: number) {
  if (value >= 1000) return formatNumber(Math.round(value));
  if (value >= 10) return value.toFixed(0);
  return value.toFixed(1);
}

function formatDate(value: string, withTime = false) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", withTime
    ? { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }
    : { year: "numeric", month: "2-digit", day: "2-digit" }
  ).format(date);
}

function projectState(meta: ProjectOverview) {
  const blocking = countBlockingReview(meta.stats);
  if (meta.model_count > 0) return { key: "deployment", label: "模型可用", tone: "blue" } as const;
  if (blocking > 0) return { key: "attention", label: "需要复查", tone: "amber" } as const;
  return { key: "active", label: "进行中", tone: "green" } as const;
}

function progressFor(meta: ProjectOverview) {
  const total = meta.stats.total ?? 0;
  if (!total) return 0;
  if (meta.model_count > 0) return 100;
  const ready = Math.max(countTrainable(meta.stats), countConfirmed(meta.stats));
  return Math.max(4, Math.min(96, Math.round((ready / total) * 100)));
}

function HomeSkeleton() {
  return (
    <div className="pm-page pm-page--loading" aria-label="正在加载项目">
      <div className="pm-stat-grid">{[0, 1, 2, 3].map((item) => <span className="pm-skeleton pm-skeleton--stat" key={item} />)}</div>
      <span className="pm-skeleton pm-skeleton--toolbar" />
      <div className="pm-list lk-scrollbar">{[0, 1, 2].map((item) => <span className="pm-skeleton pm-skeleton--row" key={item} />)}</div>
    </div>
  );
}

export default function HomePage() {
  const router = useRouter();
  const confirm = useConfirm();
  const { toast } = useToast();
  const [dashboard, setDashboard] = useState<ProjectDashboard>(EMPTY_DASHBOARD);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [stage, setStage] = useState<StageFilter>("all");
  const [createdBy, setCreatedBy] = useState("all");
  const [taskType, setTaskType] = useState<TaskTypeFilter>("all");
  const [sortBy, setSortBy] = useState<SortFilter>("recent");
  const [view, setView] = useState<ViewMode>("list");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [createModalOpen, setCreateModalOpen] = useState(false);

  const openCreateModal = useCallback(() => {
    window.history.pushState({}, "", "/?create=1");
    setCreateModalOpen(true);
  }, []);

  const closeCreateModal = useCallback(() => {
    window.history.replaceState({}, "", "/");
    setCreateModalOpen(false);
  }, []);

  const loadDashboard = useCallback(async () => {
    setError("");
    try {
      setDashboard(await api.getProjectDashboard());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "项目数据加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadDashboard(); }, [loadDashboard]);

  useEffect(() => {
    const syncCreateModal = () => setCreateModalOpen(new URLSearchParams(window.location.search).get("create") === "1");
    syncCreateModal();
    window.addEventListener("popstate", syncCreateModal);
    window.addEventListener("open-create-project", openCreateModal);
    return () => {
      window.removeEventListener("popstate", syncCreateModal);
      window.removeEventListener("open-create-project", openCreateModal);
    };
  }, [openCreateModal]);

  const filteredItems = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    return dashboard.projects.filter((meta) => {
      const action = computeContinueAction(meta.project.id, meta.stats, [], meta.model_count);
      const matchesQuery = !normalized || [meta.project.name, meta.project.description, meta.project.id]
        .join(" ").toLocaleLowerCase("zh-CN").includes(normalized);
      const matchesStatus = status === "all" || projectState(meta).key === status;
      const matchesStage = stage === "all" || action.step === stage;
      const matchesCreator = createdBy === "all" || meta.created_by === createdBy;
      const matchesType = taskType === "all" || meta.project.task_type === taskType;
      return matchesQuery && matchesStatus && matchesStage && matchesCreator && matchesType;
    }).sort((a, b) => {
      if (sortBy === "name") return a.project.name.localeCompare(b.project.name, "zh-CN");
      if (sortBy === "size") return b.project.frame_count - a.project.frame_count;
      return new Date(b.project.updated_at).getTime() - new Date(a.project.updated_at).getTime();
    });
  }, [createdBy, dashboard.projects, query, sortBy, stage, status, taskType]);

  const handleDelete = async (event: React.MouseEvent, project: Project) => {
    event.preventDefault();
    event.stopPropagation();
    const ok = await confirm({
      title: "删除项目",
      message: `确定删除项目「${project.name}」？\n将同时删除所有素材、标注、数据版本、模型和快照文件，不可恢复。`,
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    setDeleting(project.id);
    try {
      await api.deleteProject(project.id);
      await loadDashboard();
      toast({ type: "success", message: `已删除「${project.name}」` });
    } catch (deleteError) {
      toast({ type: "error", message: String(deleteError) });
    } finally {
      setDeleting(null);
    }
  };

  if (loading) return <HomeSkeleton />;

  const summary = dashboard.summary;
  const metrics = [
    { icon: "folder" as const, value: formatNumber(summary.total_projects), label: "项目总数", trend: `↑ ${formatNumber(summary.projects_last_30_days)} 本月新增` },
    { icon: "layers" as const, value: formatNumber(summary.total_data_items), label: "数据总量（帧）", trend: `↑ ${formatNumber(summary.data_items_last_30_days)} 近 30 天` },
    { icon: "users" as const, value: formatNumber(summary.active_annotators), label: "活跃标注人员", trend: `${formatNumber(summary.completed_tasks_last_30_days)} 个任务已完成` },
    { icon: "clock" as const, value: formatHours(summary.total_video_hours), label: "视频总时长（小时）", trend: `↑ ${formatHours(summary.video_hours_last_30_days)} 近 30 天` },
  ];

  return (
    <div className="pm-page">
      <section className="pm-stat-grid" aria-label="项目概览">
        {metrics.map((metric) => (
          <article className="pm-stat-card" key={metric.label}>
            <span className="pm-stat-card__icon"><Icon name={metric.icon} size={30} /></span>
            <div><strong>{metric.value}</strong><span>{metric.label}</span><small>{metric.trend}</small></div>
          </article>
        ))}
      </section>

      {error && <div className="pm-error" role="alert"><span><strong>暂时无法读取项目</strong>{error}</span><button type="button" onClick={loadDashboard}>重试</button></div>}

      <section className="pm-toolbar" aria-label="项目筛选">
        <label className="pm-search"><Icon name="search" size={19} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="按项目名称、ID 或描述搜索" /></label>
        <label className="pm-select"><span>状态</span><select value={status} onChange={(event) => setStatus(event.target.value as StatusFilter)}><option value="all">全部</option><option value="active">进行中</option><option value="attention">需要复查</option><option value="deployment">模型可用</option></select></label>
        <label className="pm-select pm-select--wide"><span>流程阶段</span><select value={stage} onChange={(event) => setStage(event.target.value as StageFilter)}><option value="all">全部</option>{STEPS.map((step) => <option value={step.slug} key={step.slug}>{step.label}</option>)}</select></label>
        <label className="pm-select pm-select--creator"><span>创建人</span><select value={createdBy} onChange={(event) => setCreatedBy(event.target.value)}><option value="all">全部</option><option value="工作区管理员">工作区管理员</option></select></label>
        <details className="pm-more-filters"><summary className="pm-filter-button"><Icon name="sliders" size={18} />更多筛选</summary><div className="pm-more-filters__popover"><label><span>任务类型</span><select value={taskType} onChange={(event) => setTaskType(event.target.value as TaskTypeFilter)}><option value="all">全部</option><option value="detect">目标检测</option><option value="classify">图像分类</option></select></label><label><span>排序方式</span><select value={sortBy} onChange={(event) => setSortBy(event.target.value as SortFilter)}><option value="recent">最近更新</option><option value="name">项目名称</option><option value="size">数据规模</option></select></label></div></details>
        <div className="pm-view-switch" aria-label="视图切换"><button type="button" className={view === "list" ? "active" : ""} aria-label="列表视图" onClick={() => setView("list")}><Icon name="list" size={20} /></button><button type="button" className={view === "grid" ? "active" : ""} aria-label="网格视图" onClick={() => setView("grid")}><Icon name="grid" size={19} /></button></div>
      </section>

      {filteredItems.length === 0 ? (
        <section className="pm-empty"><Icon name="folder" size={34} /><strong>{dashboard.projects.length ? "没有匹配的项目" : "还没有项目"}</strong><p>{dashboard.projects.length ? "调整筛选条件后再试试。" : "创建第一个项目，开始导入素材并进行智能标注。"}</p><button className="btn-primary" type="button" onClick={dashboard.projects.length ? () => { setQuery(""); setStatus("all"); setStage("all"); setCreatedBy("all"); setTaskType("all"); setSortBy("recent"); } : openCreateModal}>{dashboard.projects.length ? "清除筛选" : "新建项目"}</button></section>
      ) : (
        <section className={`pm-list pm-list--${view} lk-scrollbar`} aria-label="项目列表">
          {filteredItems.map((meta) => {
            const state = projectState(meta);
            const action = computeContinueAction(meta.project.id, meta.stats, [], meta.model_count);
            const badges = computeStepBadges(meta.stats, meta.model_count);
            const progress = progressFor(meta);
            const displaySteps = [...STEPS, { slug: "deployment" as const, label: "部署应用" }];
            return (
              <article className="pm-project-card" key={meta.project.id}>
                <div className="pm-project-card__identity">
                  <Link href={`/projects/${meta.project.id}`} className="pm-project-card__media">
                    <img
                      src={meta.project.has_custom_cover ? api.projectCoverUrl(meta.project.id) : DEFAULT_PROJECT_COVER}
                      alt={`${meta.project.name}项目封面`}
                      onError={(event) => {
                        event.currentTarget.src = DEFAULT_PROJECT_COVER;
                      }}
                    />
                  </Link>
                  <div className="pm-project-card__copy">
                    <div className="pm-project-card__title-line"><Link href={`/projects/${meta.project.id}`}>{meta.project.name}</Link><span className="pm-tag">{meta.project.task_type === "detect" ? "目标检测" : "图像分类"}</span><span className="pm-version">v{meta.latest_model_version ?? Math.max(1, meta.model_count)}</span></div>
                    <div className="pm-project-card__meta"><span>ID：{meta.project.id.slice(0, 11).toUpperCase()}</span><span>创建：{formatDate(meta.project.created_at)}</span></div>
                    <div className="pm-project-card__meta"><span>负责人：{meta.created_by}</span></div>
                    <div className="pm-project-card__chips"><span><Icon name="database" size={13} />数据：{formatNumber(meta.project.frame_count)}</span><span><Icon name="check" size={13} />任务：{formatNumber(meta.task_count)}</span><span><Icon name="layers" size={13} />类别：{formatNumber(meta.project.categories.length)}</span></div>
                  </div>
                </div>

                <div className="pm-project-card__workflow">
                  <ol className="pm-steps">
                    {displaySteps.map((step) => {
                      const badge = step.slug !== "deployment" ? badges.find((item) => item.slug === step.slug) : undefined;
                      const current = meta.model_count > 0 ? step.slug === "deployment" : step.slug === action.step;
                      const done = step.slug !== "deployment" && Boolean(badge?.done && !current);
                      return <li className={`${done ? "done" : ""} ${current ? "current" : ""}`} key={step.slug}><span>{done ? <Icon name="check" size={13} /> : current ? "●" : ""}</span><b>{step.label}</b><small>{done ? "已完成" : current ? "进行中" : "待开始"}</small></li>;
                    })}
                  </ol>
                  <div className="pm-progress"><span>总体进度</span><i><b style={{ width: `${progress}%` }} /></i><strong>{progress}%</strong></div>
                </div>

                <aside className="pm-project-card__status"><span>状态</span><b className={`pm-status pm-status--${state.tone}`}>{state.label}</b><small>更新时间<br />{formatDate(meta.project.updated_at, true)}</small><Link href={action.href}>{action.label}</Link></aside>
                <details className="pm-card-menu"><summary aria-label="更多项目操作"><Icon name="more" size={18} /></summary><div><Link href={`/projects/${meta.project.id}`}>打开项目</Link><button type="button" disabled={deleting === meta.project.id} onClick={(event) => handleDelete(event, meta.project)}>{deleting === meta.project.id ? "删除中…" : "删除项目"}</button></div></details>
              </article>
            );
          })}
        </section>
      )}

      <CreateProjectModal open={createModalOpen} onClose={closeCreateModal} onCreated={(project, warning) => { setCreateModalOpen(false); if (warning) toast({ type: "info", message: warning }); router.push(`/projects/${project.id}`); }} />
    </div>
  );
}
