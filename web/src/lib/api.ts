import { resolveApiBase } from "./api-base";
import { RUNTIME } from "./app-config";
import { clearAuthToken, getAuthToken } from "./auth";

/** 浏览器未配置时走同源 /api 代理；SSR 回退本机后端 */
export function getApiBase(): string {
  if (typeof window !== "undefined") {
    return resolveApiBase();
  }
  return resolveApiBase() || RUNTIME.apiOrigin;
}

const REQUEST_TIMEOUT_MS = 20000;

/** 给 img/src 等无法带 Authorization 的资源 URL 追加 token */
function withAuthQuery(url: string): string {
  const token = typeof window !== "undefined" ? getAuthToken() : null;
  if (!token) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}token=${encodeURIComponent(token)}`;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const token = getAuthToken();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const externalSignal = options?.signal;
  const abortFromExternal = () => controller.abort();

  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener("abort", abortFromExternal, { once: true });
  }

  try {
    const res = await fetch(`${getApiBase()}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        ...(options?.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options?.headers,
      },
    });
    if (!res.ok) {
      if (res.status === 401 && !path.startsWith("/api/auth/login")) {
        clearAuthToken();
        if (typeof window !== "undefined" && window.location.pathname !== "/login") {
          const next = `${window.location.pathname}${window.location.search}`;
          window.location.replace(`/login?next=${encodeURIComponent(next)}`);
        }
      }
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || err.error || res.statusText);
    }
    return res.json();
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("请求超时，请检查后端服务是否已启动");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    externalSignal?.removeEventListener("abort", abortFromExternal);
  }
}

export type Project = {
  id: string;
  name: string;
  description: string;
  task_type: "detect" | "classify";
  label_prompt: string;
  review_prompt: string;
  categories: Category[];
  frame_count: number;
  video_count: number;
  disk_usage_mb: number;
  has_custom_cover: boolean;
  created_at: string;
  updated_at: string;
};

export type ProjectOverview = {
  project: Project;
  created_by: string;
  stats: Record<string, number>;
  preview_frame_id: string | null;
  model_count: number;
  latest_model_version: number | null;
  task_count: number;
  completed_task_count: number;
  total_video_hours: number;
  active_annotators: number;
};

export type ProjectDashboard = {
  summary: {
    total_projects: number;
    total_data_items: number;
    active_annotators: number;
    total_video_hours: number;
    projects_last_30_days: number;
    data_items_last_30_days: number;
    completed_tasks_last_30_days: number;
    video_hours_last_30_days: number;
  };
  projects: ProjectOverview[];
};

export type AuthSession = {
  authenticated: boolean;
  id?: string;
  username: string;
  display_name?: string;
  role?: string;
  expires_at: number;
  token: string | null;
};

export type WorkspaceUser = {
  id: string;
  username: string;
  display_name: string;
  role: "admin" | "annotator" | "reviewer" | "viewer";
  status: "active" | "disabled";
  created_at: string;
  last_login_at: string | null;
};

export type UserListResponse = {
  summary: {
    total: number;
    active: number;
    admins: number;
  };
  items: WorkspaceUser[];
};

export type Category = {
  id?: string;
  class_id: number;
  name: string;
  description: string;
  color: string;
  required: boolean;
  sort_order?: number;
};

export type Frame = {
  id: string;
  filename: string;
  split: string;
  status: string;
  note: string;
  review_note: string;
  source: string;
  uncertainty: number;
  video_id: string | null;
  has_labels: boolean;
  annotations: Annotation[];
};

export type FramePage = {
  items: Frame[];
  next_cursor: string | null;
  total: number;
};

export type Annotation = {
  id?: string;
  class_id: number;
  x_center?: number | null;
  y_center?: number | null;
  width?: number | null;
  height?: number | null;
  confidence?: number;
  source?: string;
};

export type Task = {
  id: string;
  project_id: string;
  task_type: string;
  status: string;
  progress: number;
  total: number;
  params: Record<string, unknown>;
  result: Record<string, unknown>;
  log: string;
  error: string;
  cancel_requested: boolean;
  heartbeat_at: string | null;
  retry_of_task_id: string | null;
  created_at: string;
};

export type GlobalTask = Task & {
  project_name: string;
  assignee: string;
  priority: "high" | "medium" | "low";
};

export type AuditLog = {
  id: string;
  created_at: string;
  actor: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  project_id: string | null;
  project_name: string | null;
  summary: string;
  metadata: Record<string, unknown>;
  ip: string | null;
};

export type AuditLogList = {
  items: AuditLog[];
  total: number;
  page: number;
  page_size: number;
};

export type Video = {
  id: string;
  filename: string;
  duration_sec: number | null;
  fps: number | null;
  frame_count: number | null;
  split: string;
  extracted_count?: number;
  file_bytes?: number | null;
};

export type ModelVersion = {
  id: string;
  version: number;
  name: string;
  filepath: string;
  metrics: Record<string, unknown>;
  dataset_snapshot: Record<string, unknown>;
  dataset_version_id: string | null;
};

export type DatasetVersionSummary = {
  id: string;
  project_id: string;
  project_name: string;
  version: number;
  status: string;
  task_type: "detect" | "classify";
  checksum: string;
  sample_count: number;
  train_count: number;
  val_count: number;
  test_count: number;
  class_count: number;
  source_group_count: number;
  linked_model_count: number;
  created_at: string;
};

export type DatasetCatalog = {
  total_versions: number;
  project_count: number;
  snapshot_sample_count: number;
  linked_model_count: number;
  total: number;
  items: DatasetVersionSummary[];
};

export type DatasetVersionDetail = {
  summary: DatasetVersionSummary;
  categories: Array<{ class_id: number; name: string; description?: string }>;
  status_counts: Record<string, number>;
  linked_models: Array<{ id: string; name: string; version: number; created_at: string }>;
  linked_tasks: Array<{ id: string; task_type: string; status: string; created_at: string }>;
  trigger_sources: Array<{ provider: string; title: string; source_url: string }>;
};

export type ModelCatalogStat = { label: string; value: string; change: string; icon: string };
export type ModelCatalogMetric = { label: string; value: string; change: string; direction: "up" | "down" | "neutral" };
export type ModelCatalogItem = {
  id: string;
  name: string;
  version: string;
  category: string;
  description: string;
  icon: string;
  framework: string;
  task: string;
  status: string;
  metrics: ModelCatalogMetric[];
  updated_at: string;
  source?: string;
  project_name?: string | null;
  project_id?: string | null;
  model_id?: string | null;
};
export type ModelCatalog = { stats: ModelCatalogStat[]; models: ModelCatalogItem[]; total: number };

export type PublicDatasetProvider = {
  provider: "kaggle" | "roboflow";
  available: boolean;
  discovery: boolean;
  url_import: boolean;
};

export type PublicDatasetCandidate = {
  provider: "kaggle" | "roboflow";
  source_ref: string;
  source_version: string;
  source_url: string;
  title: string;
  description: string;
  license_name: string;
  license_url: string;
  license_fingerprint: string;
  download_bytes: number | null;
  image_count: number | null;
  task_type: string | null;
  classes: string[];
  updated_at: string;
  score: number;
  requires_manual_license_confirmation: boolean;
  recommendation_reason?: string;
  stars?: number | null;
  downloads?: number | null;
  views?: number | null;
  thumbnail?: string | null;
  annotation_thumbnail?: string | null;
};

export type PublicDatasetImport = {
  id: string;
  project_id: string;
  provider: string;
  source_ref: string;
  source_version: string;
  source_url: string;
  title: string;
  license_name: string;
  license_url: string;
  license_fingerprint: string;
  state: string;
  expected_download_bytes: number | null;
  actual_download_bytes: number;
  extracted_bytes: number;
  artifact_checksum: string;
  detected_format: string;
  source_classes: Array<{ class_id: number; name: string }>;
  class_mapping: Record<string, number | null>;
  suggested_mapping: Record<string, number | null>;
  quality_report: Record<string, unknown>;
  review_frame_ids: string[];
  fetch_task_id: string | null;
  import_task_id: string | null;
  dataset_version_id: string | null;
  train_task_id: string | null;
  estimated_vlm_cost: number;
};

export const api = {
  login: (username: string, password: string) =>
    request<AuthSession>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  getAuthSession: (options?: RequestInit) => request<AuthSession>("/api/auth/session", options),

  listUsers: (params: { status?: string; role?: string; q?: string } = {}) => {
    const query = new URLSearchParams();
    if (params.status) query.set("status", params.status);
    if (params.role) query.set("role", params.role);
    if (params.q) query.set("q", params.q);
    const suffix = query.toString() ? `?${query.toString()}` : "";
    return request<UserListResponse>(`/api/users${suffix}`);
  },
  createUser: (body: {
    username: string;
    display_name: string;
    password: string;
    role: WorkspaceUser["role"];
  }) =>
    request<WorkspaceUser>("/api/users", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateUser: (
    userId: string,
    body: Partial<{
      display_name: string;
      password: string;
      role: WorkspaceUser["role"];
      status: WorkspaceUser["status"];
    }>,
  ) =>
    request<WorkspaceUser>(`/api/users/${userId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteUser: (userId: string) =>
    request<{ ok: boolean }>(`/api/users/${userId}`, { method: "DELETE" }),
  getModelCatalog: () => request<ModelCatalog>("/api/models/catalog"),
  listProjects: () => request<Project[]>("/api/projects?include_disk_usage=false"),
  listProjectOverviews: () => request<ProjectOverview[]>("/api/projects/overview?include_disk_usage=false"),
  getProjectDashboard: () => request<ProjectDashboard>("/api/projects/dashboard?include_disk_usage=false"),
  getDatasetCatalog: (filters: { projectId?: string; query?: string; taskType?: string; offset?: number; limit?: number } = {}) => {
    const query = new URLSearchParams();
    if (filters.projectId) query.set("project_id", filters.projectId);
    if (filters.query) query.set("query", filters.query);
    if (filters.taskType) query.set("task_type", filters.taskType);
    query.set("offset", String(filters.offset ?? 0));
    query.set("limit", String(filters.limit ?? 100));
    return request<DatasetCatalog>(`/api/datasets?${query.toString()}`);
  },
  getDatasetVersionDetail: (projectId: string, versionId: string) =>
    request<DatasetVersionDetail>(`/api/projects/${projectId}/dataset-versions/${versionId}`),
  createProject: (body: Partial<Project> & { categories?: Category[] }) =>
    request<Project>("/api/projects", { method: "POST", body: JSON.stringify(body) }),
  getProject: (id: string) => request<Project>(`/api/projects/${id}?include_disk_usage=false`),
  getProjectDiskUsage: (id: string) =>
    request<{ disk_usage_mb: number }>(`/api/projects/${id}/disk-usage`),
  projectCoverUrl: (id: string) =>
    withAuthQuery(`${getApiBase()}/api/projects/${id}/cover`),
  uploadProjectCover: (id: string, file: File) => {
    const body = new FormData();
    body.append("file", file);
    return request<{ cover_url: string; has_custom_cover: boolean }>(`/api/projects/${id}/cover`, {
      method: "POST",
      body,
    });
  },
  updateProject: (id: string, body: Partial<Project>) =>
    request<Project>(`/api/projects/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteProject: (id: string) => request(`/api/projects/${id}`, { method: "DELETE" }),
  setCategories: (id: string, categories: Category[]) =>
    request<Category[]>(`/api/projects/${id}/categories`, {
      method: "PUT",
      body: JSON.stringify(categories),
    }),

  listVideos: (projectId: string) => request<Video[]>(`/api/projects/${projectId}/videos`),
  deleteVideo: (projectId: string, videoId: string) =>
    request<{ ok: boolean; removed_frames: number }>(`/api/projects/${projectId}/videos/${videoId}`, {
      method: "DELETE",
    }),
  videoThumbnailUrl: (projectId: string, videoId: string) =>
    withAuthQuery(`${getApiBase()}/api/projects/${projectId}/videos/${videoId}/thumbnail`),
  uploadVideo: (projectId: string, file: File, split = "train") => {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("split", split);
    return request<Video>(`/api/projects/${projectId}/videos/upload`, { method: "POST", body: fd });
  },
  uploadVideoWithProgress: (
    projectId: string,
    file: File,
    onProgress: (pct: number) => void,
    split = "train",
  ) =>
    new Promise<Video>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${getApiBase()}/api/projects/${projectId}/videos/upload`);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText));
          } catch {
            reject(new Error("解析响应失败"));
          }
        } else {
          try {
            const err = JSON.parse(xhr.responseText);
            reject(new Error(err.detail || err.error || xhr.statusText));
          } catch {
            reject(new Error(xhr.statusText));
          }
        }
      };
      xhr.onerror = () => reject(new Error("上传失败"));
      const fd = new FormData();
      fd.append("file", file);
      fd.append("split", split);
      xhr.send(fd);
    }),
  uploadImages: (projectId: string, files: File[], split = "train") => {
    const fd = new FormData();
    files.forEach((f) => fd.append("files", f));
    fd.append("split", split);
    return request<{ uploaded: number }>(`/api/projects/${projectId}/images/upload`, {
      method: "POST",
      body: fd,
    });
  },

  listFrames: (projectId: string, status?: string, sort = "uncertainty", limit = 0) =>
    request<Frame[]>(
      `/api/projects/${projectId}/frames?sort=${sort}${status ? `&status=${status}` : ""}${limit ? `&limit=${limit}` : ""}`
    ),
  listFramesPage: (
    projectId: string,
    statuses: string[],
    cursor?: string | null,
    sort = "uncertainty",
  ) => {
    const query = new URLSearchParams({ statuses: statuses.join(","), sort, limit: "100" });
    if (cursor) query.set("cursor", cursor);
    return request<FramePage>(`/api/projects/${projectId}/frames/page?${query.toString()}`);
  },

  publicDatasetProviders: () =>
    request<PublicDatasetProvider[]>("/api/public-datasets/providers"),
  roboflowPreview: (sourceRef: string, version: string) =>
    request<{ thumbnail: string | null; annotation_thumbnail: string | null }>(
      `/api/public-datasets/roboflow-preview?source_ref=${encodeURIComponent(sourceRef)}&version=${encodeURIComponent(version)}`,
    ),
  discoverPublicDatasets: (projectId: string, query: string, roboflowUrl = "") =>
    request<{ candidates: PublicDatasetCandidate[]; errors: Record<string, string> }>(
      `/api/projects/${projectId}/public-datasets/discover`,
      { method: "POST", body: JSON.stringify({ query, roboflow_url: roboflowUrl }) },
    ),
  fetchPublicDataset: (projectId: string, candidate: PublicDatasetCandidate) =>
    request<PublicDatasetImport>(`/api/projects/${projectId}/public-datasets/fetch`, {
      method: "POST",
      body: JSON.stringify({
        provider: candidate.provider,
        source_ref: candidate.source_ref,
        source_url: candidate.source_url,
        license_fingerprint: candidate.license_fingerprint,
        license_confirmed: true,
      }),
    }),
  getPublicDatasetImport: (projectId: string, importId: string) =>
    request<PublicDatasetImport>(`/api/projects/${projectId}/public-dataset-imports/${importId}`),
  listPublicDatasetImports: (projectId: string) =>
    request<PublicDatasetImport[]>(`/api/projects/${projectId}/public-dataset-imports`),
  publishPublicDataset: (
    projectId: string,
    importId: string,
    body: {
      class_mapping: Record<string, number | null>;
      warnings_confirmed: boolean;
      auto_label: boolean;
      cost_confirmed: boolean;
      training_params: Record<string, unknown>;
    },
  ) => request<Task>(`/api/projects/${projectId}/public-dataset-imports/${importId}/publish`, {
    method: "POST",
    body: JSON.stringify(body),
  }),
  approvePublicDatasetAndTrain: (projectId: string, importId: string) =>
    request<Task>(`/api/projects/${projectId}/public-dataset-imports/${importId}/approve-and-train`, {
      method: "POST",
    }),
  approveProjectPublicDatasetsAndTrain: (projectId: string) =>
    request<Task>(`/api/projects/${projectId}/public-datasets/approve-and-train`, {
      method: "POST",
    }),
  discardPublicDataset: (projectId: string, importId: string) =>
    request<{ ok: boolean; removed_frames: number }>(
      `/api/projects/${projectId}/public-dataset-imports/${importId}/discard`,
      { method: "POST" },
    ),
  frameStats: (projectId: string) =>
    request<Record<string, number>>(`/api/projects/${projectId}/frames/stats`),
  frameImageUrl: (projectId: string, frameId: string, annotated = false) =>
    withAuthQuery(
      `${getApiBase()}/api/projects/${projectId}/frames/${frameId}/image?annotated=${annotated}`,
    ),
  frameFeedback: (projectId: string, frameId: string, status: string, note = "") =>
    request(`/api/projects/${projectId}/frames/${frameId}/feedback`, {
      method: "POST",
      body: JSON.stringify({ status, note }),
    }),
  updateAnnotations: (projectId: string, frameId: string, annotations: Annotation[], status = "human_ok") =>
    request(`/api/projects/${projectId}/frames/${frameId}/annotations`, {
      method: "PUT",
      body: JSON.stringify({ annotations, status }),
    }),
  labelEstimate: (projectId: string) =>
    request<{ frame_count: number; cost_per_image: number; estimated_cost: number }>(
      `/api/projects/${projectId}/label/estimate`
    ),

  listTasks: (projectId: string) => request<Task[]>(`/api/projects/${projectId}/tasks`),
  listAllTasks: () => request<GlobalTask[]>("/api/tasks"),
  createTask: (projectId: string, task_type: string, params: Record<string, unknown> = {}) =>
    request<Task>(`/api/projects/${projectId}/tasks`, {
      method: "POST",
      body: JSON.stringify({ task_type, params }),
    }),
  getTask: (projectId: string, taskId: string) =>
    request<Task>(`/api/projects/${projectId}/tasks/${taskId}`),
  cancelTask: (projectId: string, taskId: string) =>
    request(`/api/projects/${projectId}/tasks/${taskId}/cancel`, { method: "POST" }),
  cancelRunningTask: (projectId: string) =>
    request<{ ok: boolean; task_id: string }>(`/api/projects/${projectId}/tasks/cancel-running`, {
      method: "POST",
    }),
  retryTask: (projectId: string, taskId: string) =>
    request<Task>(`/api/projects/${projectId}/tasks/${taskId}/retry`, { method: "POST" }),

  listModels: (projectId: string) => request<ModelVersion[]>(`/api/projects/${projectId}/models`),
  uploadModel: (projectId: string, file: File, name = "") => {
    const fd = new FormData();
    fd.append("file", file);
    if (name) fd.append("name", name);
    return request<ModelVersion>(`/api/projects/${projectId}/models/upload`, { method: "POST", body: fd });
  },
  predictModel: (projectId: string, modelId: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return request<{ boxes: Array<{ class_id: number; x: number; y: number; w: number; h: number; conf: number }> }>(
      `/api/projects/${projectId}/models/predict?model_id=${encodeURIComponent(modelId)}`,
      { method: "POST", body: fd },
    );
  },

  getSettings: () =>
    request<{
      dashscope_api_key_set: boolean;
      vlm_model: string;
      vlm_base_url: string;
      vlm_max_concurrency: number;
      vlm_cost_per_image: number;
    }>("/api/settings"),
  updateSettings: (body: Record<string, unknown>) =>
    request("/api/settings", { method: "PUT", body: JSON.stringify(body) }),

  listAuditLogs: (params: {
    page?: number;
    page_size?: number;
    action?: string;
    project_id?: string;
    q?: string;
    from?: string;
    to?: string;
  } = {}) => {
    const search = new URLSearchParams();
    if (params.page) search.set("page", String(params.page));
    if (params.page_size) search.set("page_size", String(params.page_size));
    if (params.action) search.set("action", params.action);
    if (params.project_id) search.set("project_id", params.project_id);
    if (params.q) search.set("q", params.q);
    if (params.from) search.set("from", params.from);
    if (params.to) search.set("to", params.to);
    const query = search.toString();
    return request<AuditLogList>(`/api/audit${query ? `?${query}` : ""}`);
  },

  pickFolder: () => request<{ path: string }>("/api/system/pick-folder", { method: "POST" }),
  openPath: (path: string) =>
    request<{ ok: boolean; path: string }>("/api/system/open-path", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),
};
