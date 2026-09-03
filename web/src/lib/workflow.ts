import { countBlockingReview, countConfirmed, countTrainable } from "./status";
import type { Task } from "./api";

export type WorkflowStep = "materials" | "label" | "review" | "train";

export const WORKFLOW_STEPS: ReadonlyArray<{
  slug: WorkflowStep;
  label: string;
  description: string;
  pageDescription: string;
}> = [
  {
    slug: "materials",
    label: "素材准备",
    description: "上传、抽帧与数据整理",
    pageDescription: "上传本地视频或图片、抽取可标注帧，或检索导入公开数据集，为本项目准备训练素材。",
  },
  {
    slug: "label",
    label: "AI 预标注",
    description: "批量生成初始标注结果",
    pageDescription: "用 YOLO 或 LLM 对未标注图片批量打框，生成待人工确认的初始标注。",
  },
  {
    slug: "review",
    label: "标注复核",
    description: "确认、修正与剔除异常",
    pageDescription: "逐张确认机器标注结果，修正漏检误检，通过后进入训练或导出。",
  },
  {
    slug: "train",
    label: "训练或导出",
    description: "训练模型或导出数据集",
    pageDescription: "用已确认标注训练 YOLO 模型，或导出标准数据集供下游使用。",
  },
];

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
  dataset_snapshot: "数据版本快照",
  extract: "提取素材",
  dedup: "素材去重",
  label: "AI 预标注",
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
      return { label: "去 AI 预标注", href: `/projects/${projectId}/label` };
    case "label":
    case "relabel":
    case "review":
      return { label: "去标注复核", href: `/projects/${projectId}/review` };
    case "train":
      return { label: "查看训练", href: `/projects/${projectId}/train` };
    case "export":
      return { label: "查看任务", href: `/tasks` };
    case "dataset_snapshot":
      return { label: "查看数据版本", href: `/datasets?project=${projectId}` };
    default:
      return null;
  }
}

export function computeContinueAction(
  projectId: string,
  stats: Record<string, number>,
  runningTasks: Task[],
  modelCount = 0,
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
  const blocking = countBlockingReview(stats);
  const trainable = countTrainable(stats);
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
      label: `继续 AI 预标注`,
      description: `${unlabeled} 张待生成初始标注`,
      href: `/projects/${projectId}/label`,
      count: unlabeled,
      primary: true,
    };
  }

  if (blocking > 0) {
    return {
      step: "review",
      label: "继续标注复核",
      description: `${blocking} 张待确认`,
      href: `/projects/${projectId}/review`,
      count: blocking,
      primary: true,
    };
  }

  if (modelCount > 0) {
    return {
      step: "train",
      label: "查看训练",
      description: `已有 ${modelCount} 个训练版本，可继续训练或导出`,
      href: `/projects/${projectId}/train`,
      primary: true,
    };
  }

  if (trainable > 0) {
    return {
      step: "train",
      label: "开始训练",
      description: `${trainable} 张已就绪，可以训练或导出`,
      href: `/projects/${projectId}/train`,
      count: trainable,
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

/** 「进入项目」专用：始终落在项目内工作页，不跳到全局模型中心/任务中心 */
export function computeProjectEntryHref(
  projectId: string,
  stats: Record<string, number>,
  runningTasks: Task[],
  modelCount = 0,
): string {
  const running = runningTasks.find((t) => t.status === "running" || t.status === "pending");
  if (running) {
    switch (running.task_type) {
      case "extract":
      case "dedup":
      case "import":
      case "derive_classify":
      case "public_fetch":
      case "public_import":
        return `/projects/${projectId}/materials`;
      case "label":
      case "relabel":
        return `/projects/${projectId}/label`;
      case "review":
        return `/projects/${projectId}/review`;
      case "train":
      case "export":
        return `/projects/${projectId}/train`;
      default:
        return `/projects/${projectId}/tasks`;
    }
  }

  const total = stats.total ?? 0;
  const unlabeled = stats.unlabeled ?? 0;
  const blocking = countBlockingReview(stats);
  const trainable = countTrainable(stats);
  const confirmed = countConfirmed(stats);

  if (total === 0) return `/projects/${projectId}/materials`;
  if (unlabeled > 0) return `/projects/${projectId}/label`;
  if (blocking > 0) return `/projects/${projectId}/review`;
  if (modelCount > 0 || trainable > 0 || confirmed > 0) return `/projects/${projectId}/train`;
  return `/projects/${projectId}/materials`;
}

export type StepBadge = {
  slug: WorkflowStep;
  count?: number;
  done?: boolean;
};

export function computeCurrentWorkflowStep(
  stats: Record<string, number>,
  modelCount = 0,
): WorkflowStep {
  const total = stats.total ?? 0;
  if (total === 0) return "materials";

  const trainable = countTrainable(stats);
  const confirmed = countConfirmed(stats);
  // 已有可训练/已确认数据或模型产出时，流程主阶段为第四阶段（前两步仍可能有角标待办）
  if (modelCount > 0 || trainable > 0 || confirmed > 0) return "train";

  const unlabeled = stats.unlabeled ?? 0;
  if (unlabeled > 0) return "label";

  const blocking = countBlockingReview(stats);
  if (blocking > 0) return "review";

  return "train";
}

export function computeStepBadges(
  stats: Record<string, number>,
  modelCount = 0,
): StepBadge[] {
  const total = stats.total ?? 0;
  const unlabeled = stats.unlabeled ?? 0;
  const blocking = countBlockingReview(stats);
  const trainable = countTrainable(stats);
  const confirmed = countConfirmed(stats);
  const reviewDone = blocking === 0 && unlabeled === 0 && (confirmed > 0 || trainable > 0);

  return [
    { slug: "materials", done: total > 0 },
    { slug: "label", count: unlabeled > 0 ? unlabeled : undefined, done: total > 0 && unlabeled === 0 },
    { slug: "review", count: blocking > 0 ? blocking : undefined, done: reviewDone },
    { slug: "train", done: modelCount > 0 },
  ];
}
