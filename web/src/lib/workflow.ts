import { countConfirmed, countPendingReview } from "@/lib/status";
import type { Task } from "@/lib/api";

export type WorkflowStep = "materials" | "label" | "review" | "train";

export type ContinueAction = {
  step: WorkflowStep;
  label: string;
  description: string;
  href: string;
  count?: number;
  primary: boolean;
};

const TASK_LABEL: Record<string, string> = {
  import: "导入数据集",
  derive_classify: "生成分类数据",
  public_fetch: "公开数据下载分析",
  public_import: "公开数据发布",
  extract: "提取素材",
  dedup: "素材去重",
  label: "自动标注",
  review: "自动审查",
  relabel: "YOLO 半自动",
  train: "训练模型",
  export: "导出数据",
};

export function taskTypeLabel(type: string) {
  return TASK_LABEL[type] ?? type;
}

export function getNextActionForTask(
  projectId: string,
  taskType: string,
): { label: string; href: string } | null {
  switch (taskType) {
    case "extract":
    case "dedup":
    case "public_fetch":
    case "public_import":
      return { label: "去自动标注", href: `/projects/${projectId}/label` };
    case "label":
    case "relabel":
    case "review":
      return { label: "去人工确认", href: `/projects/${projectId}/review` };
    case "train":
      return { label: "查看模型", href: `/models?project=${projectId}` };
    case "export":
      return { label: "查看任务", href: `/tasks` };
    default:
      return null;
  }
}

export function computeContinueAction(
  projectId: string,
  stats: Record<string, number>,
  runningTasks: Task[],
): ContinueAction {
  const running = runningTasks.find((t) => t.status === "running" || t.status === "pending");
  if (running) {
    const pct = running.total > 0 ? Math.round((running.progress / running.total) * 100) : 0;
    return {
      step: "materials",
      label: `查看进度 · ${taskTypeLabel(running.task_type)}`,
      description: `${running.progress}/${running.total}（${pct}%）进行中`,
      href: `/tasks`,
      primary: true,
    };
  }

  const total = stats.total ?? 0;
  const unlabeled = stats.unlabeled ?? 0;
  const pending = countPendingReview(stats);
  const confirmed = countConfirmed(stats);

  if (total === 0) {
    return {
      step: "materials",
      label: "上传视频开始",
      description: "还没有素材，先上传视频或图片",
      href: `/projects/${projectId}/materials`,
      primary: true,
    };
  }

  if (unlabeled > 0) {
    return {
      step: "label",
      label: `继续自动标注`,
      description: `${unlabeled} 张未标注`,
      href: `/projects/${projectId}/label`,
      count: unlabeled,
      primary: true,
    };
  }

  if (pending > 0) {
    return {
      step: "review",
      label: "继续人工确认",
      description: `${pending} 张待确认`,
      href: `/projects/${projectId}/review`,
      count: pending,
      primary: true,
    };
  }

  if (confirmed > 0) {
    return {
      step: "train",
      label: "开始训练",
      description: `${confirmed} 张已确认，可以训练或导出`,
      href: `/projects/${projectId}/train`,
      count: confirmed,
      primary: true,
    };
  }

  return {
    step: "materials",
    label: "管理素材",
    description: "查看并管理项目素材",
    href: `/projects/${projectId}/materials`,
    primary: true,
  };
}

export type StepBadge = {
  slug: WorkflowStep;
  count?: number;
  done?: boolean;
};

export function computeStepBadges(stats: Record<string, number>): StepBadge[] {
  const total = stats.total ?? 0;
  const unlabeled = stats.unlabeled ?? 0;
  const pending = countPendingReview(stats);
  const confirmed = countConfirmed(stats);

  return [
    { slug: "materials", done: total > 0 },
    { slug: "label", count: unlabeled > 0 ? unlabeled : undefined, done: total > 0 && unlabeled === 0 },
    { slug: "review", count: pending > 0 ? pending : undefined, done: pending === 0 && confirmed > 0 },
    { slug: "train", done: confirmed > 0 && pending === 0 && unlabeled === 0 },
  ];
}
