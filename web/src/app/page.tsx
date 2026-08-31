"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CreateProjectModal } from "@/components/CreateProjectModal";
import { Icon } from "@/components/Icon";
import { useTaskTray } from "@/components/TaskTrayProvider";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { TaskProgress } from "@/components/ui/TaskProgress";
import { useToast } from "@/components/ui/ToastProvider";
import { api, Project } from "@/lib/api";
import { countBlockingReview, countTrainable } from "@/lib/status";
import {
  computeContinueAction,
  computeStepBadges,
  taskTypeLabel,
  type WorkflowStep,
} from "@/lib/workflow";

type ProjectMeta = {
  project: Project;
  stats: Record<string, number>;
  previewFrameId?: string;
  modelCount: number;
};

const WORKFLOW_STEPS: { slug: WorkflowStep; label: string }[] = [
  { slug: "materials", label: "素材" },
  { slug: "label", label: "自动标注" },
  { slug: "review", label: "人工复查" },
  { slug: "train", label: "训练" },
];

function formatNumber(value: number) {
  return new Intl.NumberFormat("zh-CN").format(value || 0);
}

function formatStorage(megabytes: number) {
  if (megabytes >= 1024) return `${(megabytes / 1024).toFixed(2)} GB`;
  return `${megabytes >= 10 ? megabytes.toFixed(0) : megabytes.toFixed(2)} MB`;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function HomeSkeleton() {
  return (
    <div className="home-page" aria-label="正在加载项目">
      <section className="home-command home-command--skeleton">
        <div className="home-command__heading">
          <span className="skeleton skeleton--title" />
          <span className="skeleton skeleton--subtitle" />
        </div>
        <span className="skeleton skeleton--button" />
        <div className="home-command__metrics">
          {[0, 1, 2, 3, 4].map((item) => (
            <span className="skeleton skeleton--metric" key={item} />
          ))}
        </div>
      </section>
      <section className="home-project-panel">
        <div className="home-toolbar">
          <span className="skeleton skeleton--search" />
        </div>
        <div className="project-order-list">
          {[0, 1, 2].map((item) => (
            <div className="project-order project-order--skeleton" key={item} />
          ))}
        </div>
      </section>
    </div>
  );
}

export default function HomePage() {
  const router = useRouter();
  const confirm = useConfirm();
  const { toast } = useToast();
  const { recentTasks, runningTasks } = useTaskTray();
  const [items, setItems] = useState<ProjectMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [apiKeyMissing, setApiKeyMissing] = useState(false);
  const [query, setQuery] = useState("");
  const [taskType, setTaskType] = useState<"all" | "detect" | "classify">("all");
  const [sortBy, setSortBy] = useState<"recent" | "name" | "size">("recent");
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

  useEffect(() => {
    const syncCreateModal = () => {
      setCreateModalOpen(new URLSearchParams(window.location.search).get("create") === "1");
    };
    syncCreateModal();
    window.addEventListener("popstate", syncCreateModal);
    return () => window.removeEventListener("popstate", syncCreateModal);
  }, []);

  const loadDashboard = useCallback(async (quiet = false) => {
    if (quiet) setRefreshing(true);
    else setLoading(true);
    setError("");
    try {
      const [overviews, settings] = await Promise.all([api.listProjectOverviews(), api.getSettings()]);
      setApiKeyMissing(!settings.dashscope_api_key_set);
      setItems(overviews.map(({ project, stats, preview_frame_id, model_count }) => ({
        project,
        stats,
        previewFrameId: preview_frame_id ?? undefined,
        modelCount: model_count ?? 0,
      })));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "项目数据加载失败");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadDashboard();
  }, [loadDashboard]);

  const filteredItems = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
    return items
      .filter(({ project }) => taskType === "all" || project.task_type === taskType)
      .filter(({ project }) => {
        if (!normalizedQuery) return true;
        return [project.name, project.description]
          .join(" ")
          .toLocaleLowerCase("zh-CN")
          .includes(normalizedQuery);
      })
      .sort((a, b) => {
        if (sortBy === "name") return a.project.name.localeCompare(b.project.name, "zh-CN");
        if (sortBy === "size") return b.project.frame_count - a.project.frame_count;
        return new Date(b.project.updated_at).getTime() - new Date(a.project.updated_at).getTime();
      });
  }, [items, query, sortBy, taskType]);

  const totals = useMemo(
    () =>
      items.reduce(
        (acc, { project, stats, modelCount }) => ({
          frames: acc.frames + project.frame_count,
          storage: acc.storage + project.disk_usage_mb,
          pending: acc.pending + countBlockingReview(stats),
          unlabeled: acc.unlabeled + (stats.unlabeled ?? 0),
          trained: acc.trained + (modelCount > 0 ? 1 : 0),
          ready: acc.ready + (
            countTrainable(stats) > 0
            && countBlockingReview(stats) === 0
            && (stats.unlabeled ?? 0) === 0
            && modelCount === 0
              ? 1
              : 0
          ),
        }),
        { frames: 0, storage: 0, pending: 0, unlabeled: 0, trained: 0, ready: 0 },
      ),
    [items],
  );

  const handleDelete = async (e: React.MouseEvent, project: Project) => {
    e.preventDefault();
    e.stopPropagation();
    const ok = await confirm({
      title: "删除项目",
      message: `确定删除项目「${project.name}」？\n将同时删除所有素材、标注和模型文件，不可恢复。`,
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    setDeleting(project.id);
    try {
      await api.deleteProject(project.id);
      await loadDashboard(true);
      toast({ type: "success", message: `已删除「${project.name}」` });
    } catch (deleteError) {
      toast({ type: "error", message: String(deleteError) });
    } finally {
      setDeleting(null);
    }
  };

  if (loading) return <HomeSkeleton />;

  return (
    <div className="home-page">
      <section className="home-command" aria-labelledby="home-title">
        <div className="home-command__heading">
          <span className="home-command__eyebrow">
            <i aria-hidden="true" />
            Vision data operations
          </span>
          <h1 id="home-title">项目生产台</h1>
          <p>管理视频素材、智能标注、人工复查与模型训练的完整生产流程</p>
        </div>
        <button type="button" className="btn-primary home-create-btn" onClick={openCreateModal}>
          <Icon name="plus" size={16} />
          新建项目
        </button>
        <div className="home-command__metrics" aria-label="生产概览">
          <div className="home-metric">
            <span className="home-metric__icon"><Icon name="folder" size={17} /></span>
            <span>
              <strong>{formatNumber(items.length)}</strong>
              <small>项目</small>
            </span>
          </div>
          <div className="home-metric">
            <span className="home-metric__icon"><Icon name="image" size={17} /></span>
            <span>
              <strong>{formatNumber(totals.frames)}</strong>
              <small>数据帧</small>
            </span>
          </div>
          <div className={`home-metric ${totals.pending > 0 ? "home-metric--attention" : ""}`}>
            <span className="home-metric__icon"><Icon name="check" size={17} /></span>
            <span>
              <strong>{formatNumber(totals.pending)}</strong>
              <small>待人工复查</small>
            </span>
          </div>
          <div className={`home-metric ${runningTasks.length > 0 ? "home-metric--running" : ""}`}>
            <span className="home-metric__icon"><Icon name="play" size={17} /></span>
            <span>
              <strong>{formatNumber(runningTasks.length)}</strong>
              <small>运行任务</small>
            </span>
          </div>
          <div className="home-metric">
            <span className="home-metric__icon"><Icon name="database" size={17} /></span>
            <span>
              <strong>{formatStorage(totals.storage)}</strong>
              <small>数据占用</small>
            </span>
          </div>
        </div>
      </section>

      {apiKeyMissing && (
        <div className="home-banner home-banner--warn">
          请先在 <Link href="/settings">设置</Link> 中配置 DashScope API Key，才能使用 LLM 自动标注
        </div>
      )}

      {error && (
        <div className="dashboard-error" role="alert">
          <div>
            <strong>暂时无法读取项目</strong>
            <span>{error}</span>
          </div>
          <button type="button" className="btn-secondary" onClick={() => loadDashboard()}>重试</button>
        </div>
      )}

      {items.length === 0 ? (
        <div className="project-empty">
          <span><Icon name="folder" size={30} /></span>
          <strong>还没有项目</strong>
          <p>创建第一个项目，开始导入素材并进行智能标注。</p>
          <button type="button" className="btn-primary" onClick={openCreateModal}>
            <Icon name="plus" size={16} />
            新建项目
          </button>
        </div>
      ) : (
        <div className="home-workspace">
          <section className="home-project-panel" aria-labelledby="project-orders-title">
            <div className="home-project-panel__head">
              <div>
                <span className="home-section-kicker">Production queue</span>
                <h2 id="project-orders-title">项目工单</h2>
              </div>
              <span>{filteredItems.length} / {items.length} 个项目</span>
            </div>
            <div className="home-toolbar">
              <label className="home-search">
                <Icon name="search" size={16} />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索项目名称或描述"
                  aria-label="搜索项目"
                />
              </label>
              <label className="home-select">
                <span>类型</span>
                <select value={taskType} onChange={(e) => setTaskType(e.target.value as "all" | "detect" | "classify")}>
                  <option value="all">全部</option>
                  <option value="detect">目标检测</option>
                  <option value="classify">图像分类</option>
                </select>
              </label>
              <label className="home-select">
                <span>排序</span>
                <select value={sortBy} onChange={(e) => setSortBy(e.target.value as "recent" | "name" | "size")}>
                  <option value="recent">最近更新</option>
                  <option value="name">项目名称</option>
                  <option value="size">数据规模</option>
                </select>
              </label>
              <button
                type="button"
                className="icon-button home-refresh"
                aria-label="刷新项目"
                disabled={refreshing}
                onClick={() => loadDashboard(true)}
              >
                <Icon name="refresh" size={16} className={refreshing ? "spin" : ""} />
              </button>
            </div>
            <div className="project-order-list">
              {filteredItems.length === 0 ? (
                <div className="project-empty project-empty--compact">
                  <span><Icon name="search" size={26} /></span>
                  <strong>没有匹配的项目</strong>
                  <p>调整搜索或筛选条件后再试试。</p>
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => {
                      setQuery("");
                      setTaskType("all");
                    }}
                  >
                    清除筛选
                  </button>
                </div>
              ) : filteredItems.map((meta) => {
                const { project } = meta;
                const projectTasks = runningTasks.filter((task) => task.project_id === project.id);
                const action = computeContinueAction(project.id, meta.stats, projectTasks, meta.modelCount);
                const stageBadges = computeStepBadges(meta.stats, meta.modelCount);

                return (
                  <article className="project-order" key={project.id}>
                    <Link href={`/projects/${project.id}`} className="project-order__preview">
                      {meta.previewFrameId ? (
                        <img
                          src={api.frameImageUrl(project.id, meta.previewFrameId)}
                          alt={`${project.name}代表帧`}
                          loading="lazy"
                        />
                      ) : (
                        <span className={`project-order__placeholder project-order__placeholder--${project.task_type}`}>
                          <Icon name={project.task_type === "detect" ? "video" : "image"} size={24} />
                          <small>暂无素材</small>
                        </span>
                      )}
                      <span className="project-order__preview-tag">
                        {project.video_count > 0 ? `${formatNumber(project.video_count)} 段视频` : "图像数据"}
                      </span>
                    </Link>

                    <div className="project-order__body">
                      <div className="project-order__title-line">
                        <Link href={`/projects/${project.id}`} className="project-order__title">
                          {project.name}
                        </Link>
                        <span className={`task-badge task-badge--${project.task_type}`}>
                          {project.task_type === "detect" ? "目标检测" : "图像分类"}
                        </span>
                      </div>
                      <p className="project-order__desc">{project.description || "暂无项目描述"}</p>
                      <div className="project-order__meta">
                        <span><strong>{formatNumber(project.frame_count)}</strong> 帧</span>
                        <span><strong>{formatNumber(project.video_count)}</strong> 视频</span>
                        <span><strong>{formatStorage(project.disk_usage_mb)}</strong></span>
                        <time dateTime={project.updated_at}>更新于 {formatDate(project.updated_at)}</time>
                      </div>
                      <ol className="project-stage-rail" aria-label={`${project.name}生产流程`}>
                        {WORKFLOW_STEPS.map((step, index) => {
                          const badge = stageBadges.find((item) => item.slug === step.slug);
                          const active = action.step === step.slug;
                          return (
                            <li
                              className={[
                                "project-stage",
                                badge?.done ? "project-stage--done" : "",
                                active ? "project-stage--active" : "",
                              ].filter(Boolean).join(" ")}
                              key={step.slug}
                            >
                              <span className="project-stage__marker">
                                {badge?.done && !active ? <Icon name="check" size={12} /> : index + 1}
                              </span>
                              <span className="project-stage__label">{step.label}</span>
                              {badge?.count ? <span className="project-stage__count">{badge.count}</span> : null}
                            </li>
                          );
                        })}
                      </ol>
                    </div>

                    <div className="project-order__action">
                      <span className="project-order__action-label">下一步</span>
                      <strong>{action.label}</strong>
                      <p>{action.description}</p>
                      <Link href={action.href} className="project-order__action-link">
                        立即处理
                        <Icon name="chevron-right" size={15} />
                      </Link>
                    </div>

                    <details className="project-order__menu">
                      <summary aria-label={`更多项目操作：${project.name}`}>
                        <Icon name="more" size={18} />
                      </summary>
                      <div className="project-order__menu-popover">
                        <Link href={`/projects/${project.id}`}>打开项目</Link>
                        <button
                          type="button"
                          disabled={deleting === project.id}
                          onClick={(e) => handleDelete(e, project)}
                        >
                          <Icon name="trash" size={15} />
                          {deleting === project.id ? "删除中…" : "删除项目"}
                        </button>
                      </div>
                    </details>
                  </article>
                );
              })}
            </div>
          </section>

          <aside className="home-ops-rail" aria-label="生产动态">
            <section className="home-ops-card home-ops-card--attention">
              <div className="home-ops-card__head">
                <div>
                  <span className="home-section-kicker">Attention</span>
                  <h2>待处理</h2>
                </div>
                <span className="home-ops-card__status">
                  <i aria-hidden="true" />
                  实时
                </span>
              </div>
              <div className="home-attention-list">
                <div>
                  <span>待人工复查</span>
                  <strong>{formatNumber(totals.pending)}</strong>
                  <small>抽样或存疑，需人工确认</small>
                </div>
                <div>
                  <span>未标注素材</span>
                  <strong>{formatNumber(totals.unlabeled)}</strong>
                  <small>等待进入智能标注</small>
                </div>
                <div>
                  <span>已训练项目</span>
                  <strong>{formatNumber(totals.trained)}</strong>
                  <small>已有模型版本可试用</small>
                </div>
              </div>
            </section>

            <section className="home-ops-card">
              <div className="home-ops-card__head">
                <div>
                  <span className="home-section-kicker">Live task</span>
                  <h2>运行任务</h2>
                </div>
                <Link href="/tasks">任务中心</Link>
              </div>
              {runningTasks[0] ? (
                <div className="home-running-task">
                  <div className="home-running-task__head">
                    <span>{taskTypeLabel(runningTasks[0].task_type)}</span>
                    <StatusBadge status={runningTasks[0].status} />
                  </div>
                  <strong>{runningTasks[0].projectName}</strong>
                  <TaskProgress
                    progress={runningTasks[0].progress}
                    total={runningTasks[0].total}
                    label="处理进度"
                  />
                  {runningTasks.length > 1 && (
                    <p>另有 {runningTasks.length - 1} 个任务正在队列中</p>
                  )}
                </div>
              ) : (
                <div className="home-ops-empty">
                  <span><Icon name="check" size={17} /></span>
                  <strong>当前任务队列空闲</strong>
                  <p>启动标注或训练后，可在这里查看实时进度。</p>
                </div>
              )}
            </section>

            <section className="home-ops-card">
              <div className="home-ops-card__head">
                <div>
                  <span className="home-section-kicker">Activity log</span>
                  <h2>最近动态</h2>
                </div>
                <Link href="/tasks">全部</Link>
              </div>
              {recentTasks.length > 0 ? (
                <ul className="home-activity-list">
                  {recentTasks.slice(0, 4).map((task) => (
                    <li key={task.id}>
                      <span className={`home-activity-list__mark home-activity-list__mark--${task.status}`} />
                      <div>
                        <strong>{taskTypeLabel(task.task_type)}</strong>
                        <span>{task.projectName}</span>
                      </div>
                      <StatusBadge status={task.status} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="home-activity-empty">尚无任务记录</p>
              )}
            </section>
          </aside>
        </div>
      )}

      <CreateProjectModal
        open={createModalOpen}
        onClose={closeCreateModal}
        onCreated={(project) => {
          setCreateModalOpen(false);
          router.push(`/projects/${project.id}`);
        }}
      />
    </div>
  );
}
