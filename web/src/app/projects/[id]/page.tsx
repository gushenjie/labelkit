"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { api, Frame, ModelVersion, Project, Task } from "@/lib/api";
import { countBlockingReview, countConfirmed, countRejected } from "@/lib/status";
import {
  matchesProjectLiveEvent,
  PROJECT_STATS_REFRESH_EVENT,
} from "@/lib/project-live";
import { computeContinueAction, computeProjectEntryHref, computeStepBadges, isWorkflowStepUnlocked, taskTypeLabel, WORKFLOW_STEPS, WorkflowStep } from "@/lib/workflow";
import { Icon } from "@/components/Icon";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { TaskProgress } from "@/components/ui/TaskProgress";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/ToastProvider";

const FLOW_STEPS = WORKFLOW_STEPS;
const DEFAULT_PROJECT_COVER = "/project-art/default-project-cover.png";

const TASK_STEP: Record<string, WorkflowStep> = {
  import: "materials",
  derive_classify: "materials",
  extract: "materials",
  dedup: "materials",
  label: "label",
  relabel: "label",
  review: "review",
  train: "train",
  export: "train",
};

const numberFormatter = new Intl.NumberFormat("zh-CN");
const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});
const projectDateFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function formatDate(value?: string) {
  if (!value) return "暂无记录";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : dateFormatter.format(date);
}

function formatProjectDate(value?: string) {
  if (!value) return "暂无记录";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : projectDateFormatter.format(date);
}

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const confirm = useConfirm();
  const { toast } = useToast();
  const [project, setProject] = useState<Project | null>(null);
  const [stats, setStats] = useState<Record<string, number>>({});
  const [tasks, setTasks] = useState<Task[]>([]);
  const [models, setModels] = useState<ModelVersion[]>([]);
  const [previewFrame, setPreviewFrame] = useState<Frame | null>(null);
  const [diskUsageMb, setDiskUsageMb] = useState<number | null>(null);
  const [loadError, setLoadError] = useState("");
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!id) return;
    let disposed = false;

    const loadOverview = async () => {
      try {
        const [projectData, statsData, taskData, frameData, modelData] = await Promise.all([
          api.getProject(id),
          api.frameStats(id),
          api.listTasks(id),
          api.listFrames(id, undefined, "recent", 1).catch(() => []),
          api.listModels(id).catch(() => []),
        ]);
        if (disposed) return;
        setProject(projectData);
        setStats(statsData);
        setTasks(taskData);
        setPreviewFrame(frameData[0] ?? null);
        setModels(modelData);
        setLoadError("");
      } catch (error) {
        if (!disposed) setLoadError(String(error));
      }
    };

    let timer = 0;
    let refreshLiveData = async () => {};

    const schedule = (ms: number) => {
      window.clearInterval(timer);
      timer = window.setInterval(() => {
        if (document.visibilityState === "hidden") return;
        void refreshLiveData();
      }, ms);
    };

    refreshLiveData = async () => {
      try {
        const [statsData, taskData] = await Promise.all([
          api.frameStats(id),
          api.listTasks(id),
        ]);
        if (disposed) return;
        setStats(statsData);
        setTasks(taskData);
        const active = taskData.some((t) => t.status === "running" || t.status === "pending");
        schedule(active ? 2500 : 15000);
      } catch {
        // 保留上一次成功数据，避免短暂连接波动让页面闪空。
      }
    };

    void loadOverview().then(() => {
      if (disposed) return;
      void refreshLiveData();
    });
    void api.getProjectDiskUsage(id)
      .then((usage) => {
        if (!disposed) setDiskUsageMb(usage.disk_usage_mb);
      })
      .catch(() => {
        // 磁盘统计是非关键数据，不阻塞项目首屏。
      });

    const onStatsRefresh = (event: Event) => {
      if (!matchesProjectLiveEvent(event, id)) return;
      void refreshLiveData();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshLiveData();
    };

    window.addEventListener(PROJECT_STATS_REFRESH_EVENT, onStatsRefresh);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener(PROJECT_STATS_REFRESH_EVENT, onStatsRefresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [id]);

  const handleDelete = async () => {
    if (!id || !project) return;
    const ok = await confirm({
      title: "删除项目",
      message: `确定删除项目「${project.name}」？\n将同时删除所有素材、标注、数据版本、模型和快照文件，不可恢复。`,
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    setDeleting(true);
    try {
      await api.deleteProject(id);
      router.push("/");
    } catch (error) {
      toast({ type: "error", message: String(error) });
      setDeleting(false);
    }
  };

  const sortedTasks = useMemo(
    () =>
      [...tasks].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      ),
    [tasks],
  );

  if (loadError && !project) {
    return (
      <div className="project-overview-state">
        <span><Icon name="x" size={18} /></span>
        <h1>项目数据加载失败</h1>
        <p>{loadError}</p>
        <button type="button" className="btn-secondary" onClick={() => window.location.reload()}>
          重新加载
        </button>
      </div>
    );
  }

  if (!project || !id) {
    return (
      <div className="project-overview-loading" aria-label="正在加载项目">
        <div className="project-overview-loading__intro" role="status" aria-live="polite">
          <span />
          <div>
            <strong>正在加载项目概览</strong>
            <small>正在汇总生产链、数据质量与最近任务</small>
          </div>
        </div>
        <span className="skeleton-block" />
        <span className="skeleton-block" />
        <span className="skeleton-block" />
      </div>
    );
  }

  const total = stats.total ?? project.frame_count ?? 0;
  const unlabeled = stats.unlabeled ?? 0;
  const pending = countBlockingReview(stats);
  const confirmed = countConfirmed(stats);
  const rejected = countRejected(stats);
  const reviewed = confirmed + rejected;
  const reviewRate = total > 0 ? Math.round((reviewed / total) * 100) : 0;
  const continueAction = computeContinueAction(id, stats, tasks, models.length);
  const entryHref = computeProjectEntryHref(id, stats, tasks, models.length);
  const stepBadges = computeStepBadges(stats, models.length);
  const activeTask = sortedTasks.find(
    (task) => task.status === "running" || task.status === "pending",
  );
  const displayTask = activeTask ?? sortedTasks[0];
  const currentStep = activeTask
    ? TASK_STEP[activeTask.task_type] ?? continueAction.step
    : continueAction.step;
  const isTrainReady = total > 0 && unlabeled === 0 && pending === 0 && (confirmed > 0 || (stats.auto_ok ?? 0) > 0);
  const rejectedLabel = project.task_type === "classify" ? "已剔除" : "已驳回";
  const readinessMessage = activeTask
    ? "任务正在后台处理，完成后会自动更新本页状态。"
    : isTrainReady
      ? `${numberFormatter.format(confirmed)} 张已确认数据可用于启动训练。`
      : confirmed > 0
        ? `已有 ${numberFormatter.format(confirmed)} 张可用于试训，仍有 ${numberFormatter.format(unlabeled + pending)} 张待处理。`
        : `${numberFormatter.format(unlabeled + pending)} 张数据仍待处理，完成后即可进入训练。`;

  const stepMeta: Record<WorkflowStep, { value: string; done: boolean }> = {
    materials: {
      value: total > 0 ? `${numberFormatter.format(total)} 张` : "待导入",
      done: total > 0,
    },
    label: {
      value: unlabeled > 0 ? `${numberFormatter.format(unlabeled)} 张待处理` : total > 0 ? "已完成" : "未开始",
      done: total > 0 && unlabeled === 0,
    },
    review: {
      value: pending > 0 ? `${numberFormatter.format(pending)} 张待确认` : reviewed > 0 ? `${reviewed}/${total}` : "未开始",
      done: reviewed > 0 && pending === 0 && unlabeled === 0,
    },
    train: {
      value: models.length > 0 ? `${models.length} 个模型` : isTrainReady ? "可启动" : "未就绪",
      done: models.length > 0,
    },
  };

  const qualityItems = [
    { key: "confirmed", label: "可训练", value: confirmed, tone: "confirmed" },
    { key: "rejected", label: rejectedLabel, value: rejected, tone: "rejected" },
    { key: "pending", label: "待复查", value: pending, tone: "pending" },
    { key: "unlabeled", label: "未标注", value: unlabeled, tone: "unlabeled" },
  ];

  return (
    <div className="project-overview">
      <section className="project-overview__hero">
        <div className="project-overview__identity">
          <div className="project-overview__eyebrow">
            <span>项目</span>
          </div>
          <h1>{project.name}</h1>
          <p>{project.description || "基于视觉识别技术，构建、验证与迭代火焰检测模型。"}</p>
          <div className="project-overview__meta">
            <span><small>项目负责人</small><strong><i>{(project.created_by || "未").slice(0, 1)}</i>{project.created_by || "未指定"}</strong></span>
            <span><small>项目阶段</small><strong>数据生产中 <Icon name="chevron-down" size={14} /></strong></span>
            <span><small>创建时间</small><strong>{formatProjectDate(project.created_at)}</strong></span>
            <span><small>项目 ID</small><strong>PJ-{project.id.slice(0, 8).toUpperCase()}</strong></span>
          </div>
          <div className="project-overview__decision">
            <span>{isTrainReady ? "训练就绪" : confirmed > 0 ? "可先试训" : "当前建议"}</span>
            <p>{readinessMessage}</p>
          </div>
          <div className="project-overview__actions">
            <Link href={entryHref} className="project-overview__primary-action" title={continueAction.description}>
              <span>
                <strong>{continueAction.label}</strong>
              </span>
              <Icon name="arrow-right" size={18} />
            </Link>
            <Link href={`/projects/${id}/settings`} className="project-overview__secondary-action">
              <Icon name="settings" size={16} />
              项目设置
            </Link>
          </div>
        </div>

        <div className="project-overview__preview">
          <img
            src={
              project.has_custom_cover
                ? api.projectCoverUrl(id)
                : previewFrame
                  ? api.frameImageUrl(id, previewFrame.id)
                  : DEFAULT_PROJECT_COVER
            }
            alt={
              project.has_custom_cover
                ? `${project.name}项目封面`
                : previewFrame
                  ? `${project.name} 最近素材：${previewFrame.filename}`
                  : `${project.name}默认封面`
            }
            onError={(event) => {
              event.currentTarget.src = DEFAULT_PROJECT_COVER;
            }}
          />
        </div>
      </section>

      <div className="project-overview__layout">
        <div className="project-overview__main">
          <section className="project-control-panel project-pipeline">
            <header className="project-control-panel__head">
              <div>
                <span className="project-section-kicker">Production flow</span>
                <h2>数据生产链</h2>
              </div>
              <Link href={`/projects/${id}/tasks`}>
                查看生产链详情 <Icon name="chevron-right" size={14} />
              </Link>
            </header>

            <div className="project-pipeline__steps">
              {FLOW_STEPS.map((step, index) => {
                const state = currentStep === step.slug
                  ? "active"
                  : stepMeta[step.slug].done
                    ? "done"
                    : "waiting";
                const unlocked = isWorkflowStepUnlocked(step.slug, stepBadges, stats);
                const previousLabel = index > 0 ? FLOW_STEPS[index - 1].label : "";
                const className = `project-pipeline__step project-pipeline__step--${state}${unlocked ? "" : " project-pipeline__step--locked"}`;
                const body = (
                  <>
                    <span className="project-pipeline__marker">
                      {state === "done" ? <Icon name="check" size={14} /> : index + 1}
                    </span>
                    <span className="project-pipeline__copy">
                      <strong>{step.label}</strong>
                      <small>{state === "done" ? "已完成" : state === "active" ? "进行中" : unlocked ? "待开始" : "未解锁"}</small>
                    </span>
                    <em>{stepMeta[step.slug].value}</em>
                  </>
                );
                if (!unlocked) {
                  return (
                    <span
                      key={step.slug}
                      className={className}
                      aria-disabled="true"
                      title={`请先完成「${previousLabel}」后再进入此步骤`}
                    >
                      {body}
                    </span>
                  );
                }
                return (
                  <Link
                    key={step.slug}
                    href={`/projects/${id}/${step.slug}`}
                    className={className}
                  >
                    {body}
                  </Link>
                );
              })}
            </div>
          </section>

          <section className="project-control-panel project-quality">
            <header className="project-control-panel__head">
              <div>
                <span className="project-section-kicker">Data readiness</span>
                <h2>数据就绪判断</h2>
              </div>
              <Link href={`/projects/${id}/review`}>
                查看复查明细
                <Icon name="chevron-right" size={14} />
              </Link>
            </header>

            <div className="project-quality__body">
              <div className="project-quality__score">
                <strong>{reviewRate}<sup>%</sup></strong>
                <span>标注复核覆盖率</span>
                <small>{numberFormatter.format(reviewed)} / {numberFormatter.format(total)} 张已判定</small>
              </div>

              <div className="project-quality__distribution">
                <div className="project-quality__summary">
                  <strong>
                    {isTrainReady
                      ? `${numberFormatter.format(confirmed)} 张数据已具备训练条件`
                      : `${numberFormatter.format(unlabeled + pending)} 张数据仍需处理`}
                  </strong>
                  <p>
                    {rejected > 0
                      ? `${numberFormatter.format(rejected)} 张${rejectedLabel}，不会进入本轮训练集。`
                      : "当前没有被剔除或驳回的数据。"}
                  </p>
                </div>

                <div className="project-quality__bar" aria-label="数据状态分布">
                  {qualityItems.map((item) => (
                    item.value > 0 && total > 0 ? (
                      <span
                        key={item.key}
                        className={`project-quality__segment project-quality__segment--${item.tone}`}
                        style={{ width: `${(item.value / total) * 100}%` }}
                        title={`${item.label} ${item.value} 张`}
                      />
                    ) : null
                  ))}
                </div>

                <div className="project-quality__legend">
                  {qualityItems.map((item) => (
                    <div key={item.key}>
                      <span className={`project-quality__dot project-quality__dot--${item.tone}`} />
                      <small>{item.label}</small>
                      <strong>{numberFormatter.format(item.value)}</strong>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </section>
        </div>

        <aside className="project-overview__rail" aria-label="项目运行信息">
          <section className="project-rail-section">
            <header>
              <div>
                <span className="project-section-kicker">Live task</span>
                <h2>当前任务</h2>
              </div>
              <Link href="/tasks">查看任务中心 <Icon name="chevron-right" size={14} /></Link>
            </header>
            {displayTask ? (
              <div className="project-live-task">
                <div className="project-live-task__heading">
                  <span className="project-live-task__icon"><Icon name="sparkles" size={18} /></span>
                  <strong>任务：{taskTypeLabel(displayTask.task_type)}</strong>
                  <StatusBadge status={displayTask.status} />
                </div>
                <p>{activeTask ? "任务正在后台运行，可继续浏览其他页面。" : "最近一次任务已经完成，可查看结果或继续下一环节。"}</p>
                <TaskProgress
                  progress={displayTask.progress}
                  total={displayTask.total}
                  label="进度"
                />
                <div className="project-live-task__meta">
                  <span>执行人：工作区管理员</span>
                  <span>更新：{formatProjectDate(displayTask.heartbeat_at || displayTask.created_at)}</span>
                </div>
              </div>
            ) : (
              <div className="project-idle-state">
                <span><Icon name="check" size={17} /></span>
                <div>
                  <strong>任务队列空闲</strong>
                  <p>没有正在运行或等待中的任务</p>
                </div>
              </div>
            )}
            <Link href={continueAction.href} className="project-task-action">
              继续处理 <Icon name="play" size={15} />
            </Link>
          </section>

          <section className="project-rail-section">
            <header>
              <div>
                <span className="project-section-kicker">Project assets</span>
                <h2>项目资产</h2>
              </div>
              <Link href={`/projects/${id}/materials`}>查看全部资产 <Icon name="chevron-right" size={14} /></Link>
            </header>
            <dl className="project-assets">
              <div>
                <dt><i><Icon name="database" size={19} /></i>数据集</dt>
                <dd><strong>{numberFormatter.format(total)}</strong><small>个</small><em>{diskUsageMb === null ? "统计中" : `${diskUsageMb.toFixed(2)} MB`}</em></dd>
              </div>
              <div>
                <dt><i><Icon name="archive" size={19} /></i>标注任务</dt>
                <dd><strong>{tasks.length}</strong><small>个</small><em>{diskUsageMb === null ? "统计中" : `${diskUsageMb.toFixed(2)} MB`}</em></dd>
              </div>
              <div>
                <dt><i><Icon name="cube" size={19} /></i>模型版本</dt>
                <dd><strong>{models.length}</strong><small>个</small><em>{models.length && diskUsageMb !== null ? `${Math.max(1, diskUsageMb / 2).toFixed(2)} MB` : "—"}</em></dd>
              </div>
            </dl>
            {project.categories.length > 0 && (
              <div className="project-categories">
                <span>类别定义</span>
                <div>
                  {project.categories.map((category) => (
                    <span key={category.id || category.class_id}>
                      <i style={{ background: category.color }} aria-hidden="true" />
                      {category.name}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </section>

          <section className="project-rail-section project-rail-section--activity">
            <header>
              <div>
                <span className="project-section-kicker">Recent activity</span>
                <h2>最近任务</h2>
              </div>
              <Link href="/tasks">全部</Link>
            </header>
            {sortedTasks.length > 0 ? (
              <ul className="project-task-list">
                {sortedTasks.slice(0, 3).map((task) => (
                  <li key={task.id}>
                    <span className={`project-task-list__mark project-task-list__mark--${task.status}`} />
                    <div>
                      <strong>{taskTypeLabel(task.task_type)}</strong>
                      <small>{formatDate(task.created_at)}</small>
                    </div>
                    <StatusBadge status={task.status} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="project-task-list__empty">尚无任务记录</p>
            )}
          </section>

          <footer className="project-rail-footer">
            <Link href={`/projects/${id}/settings`}>
              <Icon name="settings" size={15} />
              编辑项目配置
            </Link>
            <button type="button" disabled={deleting} onClick={handleDelete}>
              <Icon name="trash" size={15} />
              {deleting ? "删除中…" : "删除项目"}
            </button>
          </footer>
        </aside>
      </div>
    </div>
  );
}
