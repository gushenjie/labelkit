/** 帧标注流程状态（内部值，详情展开可见） */

export const TASK_STATUS_ZH: Record<string, string> = {
  pending: "等待中",
  running: "进行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  paused: "已暂停",
  interrupted: "已中断",
};

export const FRAME_STATUS_ZH: Record<string, string> = {
  unlabeled: "未标注",
  llm_labeled: "LLM已标",
  auto_ok: "机器通过",
  auto_fixed: "已自动修复",
  needs_human: "机器存疑",
  human_ok: "人工确认",
  human_wrong: "已驳回",
  no_target: "无目标",
  total: "总素材",
};

/** 用户看到的简化状态（复查页徽章等） */
export const FRAME_STATUS_SIMPLE: Record<string, string> = {
  unlabeled: "未标注",
  llm_labeled: "待确认",
  auto_ok: "机器通过",
  auto_fixed: "待确认",
  needs_human: "待抽样",
  human_wrong: "已驳回",
  human_ok: "已确认",
  no_target: "已确认",
};

export type ReviewFilter = "manual" | "pending" | "sample" | "rejected" | "confirmed" | "all";

/** 需要人工逐张确认的状态（不含可直接训练的 auto_ok） */
const PENDING_REVIEW = new Set([
  "llm_labeled",
  "needs_human",
  "auto_fixed",
]);

const REJECTED_REVIEW = new Set(["human_wrong"]);
const CONFIRMED_REVIEW = new Set(["human_ok", "no_target"]);

/** 「全部」含机器通过帧，避免与「待确认」语义撞车 */
const ALL_REVIEW = new Set([
  "auto_ok",
  "llm_labeled",
  "needs_human",
  "auto_fixed",
  "human_wrong",
  "human_ok",
  "no_target",
]);

export function reviewStatuses(filter: ReviewFilter): string[] {
  if (filter === "manual") return ["unlabeled"];
  if (filter === "pending") return [...PENDING_REVIEW];
  if (filter === "sample") return ["needs_human"];
  if (filter === "rejected") return [...REJECTED_REVIEW];
  if (filter === "confirmed") return [...CONFIRMED_REVIEW];
  return [...ALL_REVIEW];
}

export function countSampleReview(stats: Record<string, number>): number {
  return stats.needs_human ?? 0;
}

/** 必须人工处理才能继续训练/导出的帧数（不含机器已通过的 auto_ok） */
export function countBlockingReview(stats: Record<string, number>): number {
  return (
    (stats.llm_labeled ?? 0) +
    (stats.needs_human ?? 0) +
    (stats.auto_fixed ?? 0)
  );
}

/** 可参与训练的已标注帧数 */
export function countTrainable(stats: Record<string, number>): number {
  return (
    (stats.auto_ok ?? 0) +
    (stats.auto_fixed ?? 0) +
    (stats.human_ok ?? 0) +
    (stats.no_target ?? 0)
  );
}

/** 待人工确认数；与 blocking 对齐，不再把 auto_ok 算进来 */
export function countPendingReview(stats: Record<string, number>): number {
  return countBlockingReview(stats);
}

export function countRejected(stats: Record<string, number>): number {
  return stats.human_wrong ?? 0;
}

export function countConfirmed(stats: Record<string, number>): number {
  return (stats.human_ok ?? 0) + (stats.no_target ?? 0);
}

/** 抽样之外仍需人工确认的数量（LLM/自动修复等） */
export function countNonSamplePendingReview(stats: Record<string, number>): number {
  return (stats.llm_labeled ?? 0) + (stats.auto_fixed ?? 0);
}

export function filterFramesForReview<T extends { status: string }>(
  frames: T[],
  filter: ReviewFilter
): T[] {
  if (filter === "manual") return frames.filter((f) => f.status === "unlabeled");
  const labeled = frames.filter((f) => f.status !== "unlabeled");
  if (filter === "all") return labeled;
  if (filter === "sample") return labeled.filter((f) => f.status === "needs_human");
  if (filter === "pending") return labeled.filter((f) => PENDING_REVIEW.has(f.status));
  if (filter === "rejected") return labeled.filter((f) => REJECTED_REVIEW.has(f.status));
  return labeled.filter((f) => CONFIRMED_REVIEW.has(f.status));
}

/** URL / 旧参数兼容 */
export function normalizeReviewFilter(param: string | null): ReviewFilter {
  if (param === "manual" || param === "unlabeled") return "manual";
  if (param === "confirmed" || param === "human_ok") return "confirmed";
  if (param === "rejected" || param === "human_wrong") return "rejected";
  if (param === "sample" || param === "needs_human") return "sample";
  if (param === "all") return "all";
  return "pending";
}

export const REVIEW_FILTERS: { value: ReviewFilter; label: string; hint: string }[] = [
  { value: "manual", label: "人工标注", hint: "从零绘制标注，保存后直接记为人工确认" },
  { value: "sample", label: "抽样复查", hint: "公开数据风险抽样，确认完才能训练" },
  { value: "pending", label: "待确认", hint: "预标注结果需逐张确认（不含已机器通过）" },
  { value: "rejected", label: "已驳回", hint: "点了 N 驳回的图，可手改框或 YOLO 修正" },
  { value: "confirmed", label: "已确认", hint: "人工确认完成，可参与训练" },
  { value: "all", label: "全部", hint: "所有已标注图片（含机器通过）" },
];

/** 按当前队列决定展示哪些筛选 Tab，避免抽样场景下「待确认≈全部」 */
export function visibleReviewFilters(stats: Record<string, number>): ReviewFilter[] {
  const sampleCount = countSampleReview(stats);
  const nonSamplePending = countNonSamplePendingReview(stats);
  return REVIEW_FILTERS
    .filter((item) => {
      if (item.value === "manual") return (stats.unlabeled ?? 0) > 0;
      if (item.value === "sample") return sampleCount > 0;
      // 抽样进行中且没有其它待人工项时，隐藏「待确认」，避免与抽样/全部冲突
      if (item.value === "pending") return sampleCount === 0 || nonSamplePending > 0;
      return true;
    })
    .map((item) => item.value);
}

/** 项目概览：5 项汇总 */
export function summarizeFrameStats(stats: Record<string, number>) {
  return [
    { key: "total", label: "总素材", value: stats.total ?? 0, hint: "已上传的图片帧" },
    {
      key: "pending",
      label: "未标注",
      value: stats.unlabeled ?? 0,
      hint: "等待 LLM 打标",
    },
    {
      key: "review",
      label: "待确认",
      value: countPendingReview(stats),
      hint: "需人工确认或修正（不含机器通过）",
    },
    {
      key: "confirmed",
      label: "已确认",
      value: countConfirmed(stats),
      hint: "人工确认完成",
    },
    {
      key: "rejected",
      label: "已驳回",
      value: countRejected(stats),
      hint: "点了 N 驳回，需改框或 YOLO 修正",
    },
  ];
}
