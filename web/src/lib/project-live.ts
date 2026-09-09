/** 项目级实时数据：按需刷新，避免无差别轮询。 */

export const PROJECT_STATS_REFRESH_EVENT = "labelkit:project-stats-refresh";
export const PROJECT_MODELS_REFRESH_EVENT = "labelkit:project-models-refresh";

type ProjectLiveDetail = { projectId?: string };

function emit(name: string, projectId?: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<ProjectLiveDetail>(name, { detail: { projectId } }));
}

/** 请求刷新帧统计（步骤角标、待复核数等） */
export function requestProjectStatsRefresh(projectId?: string) {
  emit(PROJECT_STATS_REFRESH_EVENT, projectId);
}

/** 请求刷新模型列表/数量（训练完成后步骤解锁） */
export function requestProjectModelsRefresh(projectId?: string) {
  emit(PROJECT_MODELS_REFRESH_EVENT, projectId);
}

export function matchesProjectLiveEvent(event: Event, projectId: string): boolean {
  const detail = (event as CustomEvent<ProjectLiveDetail>).detail;
  return !detail?.projectId || detail.projectId === projectId;
}
