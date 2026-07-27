/** 人工确认页 URL：支持按筛选分组并定位到指定帧 */

export function reviewPageUrl(
  projectId: string,
  opts?: { filter?: string; frameId?: string }
) {
  const params = new URLSearchParams();
  if (opts?.filter) params.set("filter", opts.filter);
  if (opts?.frameId) params.set("frame", opts.frameId);
  const q = params.toString();
  return `/projects/${projectId}/review${q ? `?${q}` : ""}`;
}

/** 从标注页进入人工确认：按帧状态落到对应筛选 */
export function reviewFilterForFrame(status: string): string {
  if (status === "human_wrong") return "rejected";
  if (status === "human_ok" || status === "no_target") return "confirmed";
  return "pending";
}
