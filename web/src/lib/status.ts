/** 帧标注流程状态（内部值，详情展开可见） */

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
  auto_ok: "待确认",
  auto_fixed: "待确认",
  needs_human: "待确认",
  human_wrong: "已驳回",
  human_ok: "已确认",
  no_target: "已确认",
};

export type ReviewFilter = "pending" | "rejected" | "confirmed" | "all";

const PENDING_REVIEW = new Set([
  "auto_ok",
  "llm_labeled",
  "needs_human",
  "auto_fixed",
]);

const REJECTED_REVIEW = new Set(["human_wrong"]);
const CONFIRMED_REVIEW = new Set(["human_ok", "no_target"]);

export function countPendingReview(stats: Record<string, number>): number {
  return (
    (stats.auto_ok ?? 0) +
    (stats.llm_labeled ?? 0) +
    (stats.needs_human ?? 0) +
    (stats.auto_fixed ?? 0)
  );
}

export function countRejected(stats: Record<string, number>): number {
  return stats.human_wrong ?? 0;
}

export function countConfirmed(stats: Record<string, number>): number {
  return (stats.human_ok ?? 0) + (stats.no_target ?? 0);
}

export function filterFramesForReview<T extends { status: string }>(
  frames: T[],
  filter: ReviewFilter
): T[] {
  const labeled = frames.filter((f) => f.status !== "unlabeled");
  if (filter === "all") return labeled;
  if (filter === "pending") return labeled.filter((f) => PENDING_REVIEW.has(f.status));
  if (filter === "rejected") return labeled.filter((f) => REJECTED_REVIEW.has(f.status));
  return labeled.filter((f) => CONFIRMED_REVIEW.has(f.status));
}

/** URL / 旧参数兼容 */
export function normalizeReviewFilter(param: string | null): ReviewFilter {
  if (param === "confirmed" || param === "human_ok") return "confirmed";
  if (param === "rejected" || param === "human_wrong") return "rejected";
  if (param === "all") return "all";
  return "pending";
}

export const REVIEW_FILTERS: { value: ReviewFilter; label: string; hint: string }[] = [
  { value: "pending", label: "待确认", hint: "机器已打标，等你逐张确认" },
  { value: "rejected", label: "已驳回", hint: "点了 N 驳回的图，可手改框或 YOLO 修正" },
  { value: "confirmed", label: "已确认", hint: "人工确认完成，可参与训练" },
  { value: "all", label: "全部", hint: "所有已标注图片" },
];

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
      hint: "等你逐张确认或修正",
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
