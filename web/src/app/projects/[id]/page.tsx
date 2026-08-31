"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { api, Frame, ModelVersion, Project, Task } from "@/lib/api";
import { countBlockingReview, countConfirmed, countRejected } from "@/lib/status";
import { computeContinueAction, taskTypeLabel, WorkflowStep } from "@/lib/workflow";
import { Icon } from "@/components/Icon";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { TaskProgress } from "@/components/ui/TaskProgress";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/ToastProvider";

const FLOW_STEPS: Array<{
  slug: WorkflowStep;
  label: string;
  description: string;
}> = [
  { slug: "materials", label: "素材准备", description: "上传、抽帧与数据整理" },
  { slug: "label", label: "智能标注", description: "批量生成预标注结果" },
  { slug: "review", label: "人工复查", description: "确认质量与剔除异常" },
  { slug: "train", label: "训练导出", description: "训练模型或导出数据集" },
];

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

function formatDate(value?: string) {
  if (!value) return "暂无记录";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : dateFormatter.format(date);
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

    const refreshLiveData = async () => {
      try {
        const [statsData, taskData] = await Promise.all([
          api.frameStats(id),
          api.listTasks(id),
        ]);
        if (!disposed) {
          setStats(statsData);
          setTasks(taskData);
        }
      } catch {
        // 保留上一次成功数据，避免短暂连接波动让页面闪空。
      }
    };

    void loadOverview();
    const timer = window.setInterval(refreshLiveData, 5000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [id]);

  const handleDelete = async () => {
    if (!id || !project) return;
    const ok = await confirm({
      title: "删除项目",
      message: `确定删除项目「${project.name}」？\n将同时删除所有素材、标注和模型文件，不可恢复。`,
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
  const activeTask = sortedTasks.find(
    (task) => task.status === "running" || task.status === "pending",
  );
  const currentStep = activeTask
    ? TASK_STEP[activeTask.task_type] ?? continueAction.step
    : continueAction.step;
  const isTrainReady = total > 0 && unlabeled === 0 && pending === 0 && (confirmed > 0 || (stats.auto_ok ?? 0) > 0);
  const projectState = activeTask
    ? { label: "任务运行中", tone: "running" }
    : isTrainReady
      ? { label: "训练就绪", tone: "ready" }
      : pending > 0
        ? { label: "等待复查", tone: "review" }
        : unlabeled > 0
          ? { label: "等待标注", tone: "label" }
          : { label: "等待素材", tone: "empty" };
  const rejectedLabel = project.task_type === "classify" ? "已剔除" : "已驳回";

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
            <span>PROJECT CONTROL</span>
            <i aria-hidden="true" />
            <strong className={`project-state project-state--${projectState.tone}`}>
              {projectState.label}
            </strong>
          </div>
          <h1>{project.name}</h1>
          <p>{project.description || "集中管理项目素材、标注、复查与模型训练。"}</p>
          <div className="project-overview__meta">
            <span>{project.task_type === "classify" ? "图像分类" : "目标检测"}</span>
            <span>{project.categories.length} 个类别</span>
            <span>{project.disk_usage_mb.toFixed(2)} MB</span>
            <span>更新于 {formatDate(project.updated_at)}</span>
          </div>
          <div className="project-overview__actions">
            <Link href={continueAction.href} className="project-overview__primary-action">
              <span>
                <small>下一步</small>
                <strong>{continueAction.label}</strong>
              </span>
              <Icon name="chevron-right" size={18} />
            </Link>
            <Link href={`/projects/${id}/settings`} className="project-overview__secondary-action">
              <Icon name="settings" size={16} />
              项目设置
            </Link>
          </div>
        </div>

        <div className="project-overview__preview">
          {previewFrame ? (
            <img
              src={api.frameImageUrl(id, previewFrame.id)}
              alt={`${project.name} 最近素材：${previewFrame.filename}`}
            />
          ) : (
            <span className="project-overview__preview-empty">
              <Icon name="image" size={28} />
              暂无项目素材
            </span>
          )}
          <div>
            <span>最近素材</span>
            <strong>{previewFrame?.filename || "等待导入数据"}</strong>
          </div>
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
              <p>
                当前环节
                <strong>{FLOW_STEPS.find((step) => step.slug === currentStep)?.label}</strong>
              </p>
            </header>

            <div className="project-pipeline__steps">
              {FLOW_STEPS.map((step, index) => {
                const state = currentStep === step.slug
                  ? "active"
                  : stepMeta[step.slug].done
                    ? "done"
                    : "waiting";
                return (
                  <Link
                    key={step.slug}
                    href={`/projects/${id}/${step.slug}`}
                    className={`project-pipeline__step project-pipeline__step--${state}`}
                  >
                    <span className="project-pipeline__marker">
                      {state === "done" ? <Icon name="check" size={14} /> : index + 1}
                    </span>
                    <span className="project-pipeline__copy">
                      <strong>{step.label}</strong>
                      <small>{step.description}</small>
                    </span>
                    <em>{stepMeta[step.slug].value}</em>
                  </Link>
                );
              })}
            </div>
          </section>

          <section className="project-control-panel project-quality">
            <header className="project-control-panel__head">
              <div>
                <span className="project-section-kicker">Data readiness</span>
                <h2>数据质量状态</h2>
              </div>
              <Link href={`/projects/${id}/review`}>
                查看复查明细
                <Icon name="chevron-right" size={14} />
              </Link>
            </header>

            <div className="project-quality__body">
              <div className="project-quality__score">
                <strong>{reviewRate}<sup>%</sup></strong>
                <span>复查完成率</span>
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
              {activeTask && <StatusBadge status={activeTask.status} />}
            </header>
            {activeTask ? (
              <div className="project-live-task">
                <strong>{taskTypeLabel(activeTask.task_type)}</strong>
                <p>任务正在后台运行，可继续浏览其他页面。</p>
                <TaskProgress
                  progress={activeTask.progress}
                  total={activeTask.total}
                  label="处理进度"
                />
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
          </section>

          <section className="project-rail-section">
            <header>
              <div>
                <span className="project-section-kicker">Project assets</span>
                <h2>项目资产</h2>
              </div>
            </header>
            <dl className="project-assets">
              <div><dt>数据帧</dt><dd>{numberFormatter.format(total)}</dd></div>
              <div><dt>视频</dt><dd>{project.video_count}</dd></div>
              <div><dt>模型版本</dt><dd>{models.length}</dd></div>
              <div><dt>存储占用</dt><dd>{project.disk_usage_mb.toFixed(2)} MB</dd></div>
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

          <section className="project-rail-section">
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
