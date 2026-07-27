/** 标注页：首轮自动打标 */
export const FIRST_LABEL_TARGET = {
  value: "unlabeled",
  label: "未标注",
  hint: "还没打过框的图",
} as const;

/** 人工确认页：仅对已驳回批量修正 */
export const REJECT_FIX_TARGET = {
  value: "human_wrong",
  label: "已驳回",
  hint: "人工确认时点了 N 驳回的图",
} as const;

/** @deprecated 请使用 FIRST_LABEL_TARGET 或 REJECT_FIX_TARGET */
export const RELABEL_TARGETS = [REJECT_FIX_TARGET] as const;

export function countRelabelTarget(
  onlyStatus: string,
  stats: Record<string, number>
): number {
  if (onlyStatus === "human_wrong") return stats.human_wrong ?? 0;
  if (onlyStatus === "unlabeled") return stats.unlabeled ?? 0;
  return (
    (stats.auto_ok ?? 0) +
    (stats.llm_labeled ?? 0) +
    (stats.needs_human ?? 0) +
    (stats.auto_fixed ?? 0)
  );
}
