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
const DISCOVER_TIMEOUT_MS = 90000;
const PUBLIC_FETCH_TIMEOUT_MS = 90000;

type RequestOptions = RequestInit & {
  timeoutMs?: number;
  /** 覆盖默认 API 基址（大文件直连后端可绕开 Next 代理体积限制） */
  apiBase?: string;
};

/** 给 img/src 等无法带 Authorization 的资源 URL 追加 token */
function withAuthQuery(url: string): string {
  const token = typeof window !== "undefined" ? getAuthToken() : null;
  if (!token) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}token=${encodeURIComponent(token)}`;
}

async function request<T>(path: string, options?: RequestOptions): Promise<T> {
  const token = getAuthToken();
  const {
    timeoutMs = REQUEST_TIMEOUT_MS,
    signal: externalSignal,
    apiBase,
    ...fetchOptions
  } = options ?? {};
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const abortFromExternal = () => controller.abort();

  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener("abort", abortFromExternal, { once: true });
  }

  try {
    const res = await fetch(`${apiBase ?? getApiBase()}${path}`, {
      ...fetchOptions,
      signal: controller.signal,
      headers: {
        ...(fetchOptions.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...fetchOptions.headers,
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
      const detail = err.detail;
      const detailMessage = typeof detail === "string"
        ? detail
        : detail && typeof detail === "object" && "message" in detail && typeof detail.message === "string"
          ? detail.message
          : Array.isArray(detail)
            ? detail
                .map((item) => {
                  if (!item || typeof item !== "object") return "";
                  const loc = Array.isArray(item.loc) ? item.loc.filter((part) => part !== "body").join(".") : "";
                  const msg = typeof item.msg === "string" ? item.msg : "";
                  return [loc, msg].filter(Boolean).join(": ");
                })
                .filter(Boolean)
                .join("；")
            : "";
      throw new Error(detailMessage || err.error || res.statusText);
    }
    return res.json();
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(
        timeoutMs >= 60_000
          ? "上传或处理超时，大文件请稍后重试"
          : timeoutMs > REQUEST_TIMEOUT_MS
            ? "公开数据检索超时，可能是外网数据源响应较慢，请稍后重试"
            : "请求超时，请检查后端服务是否已启动",
      );
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
  created_by: string;
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
  material_batch_id?: string | null;
  ingest_origin?: string;
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
  started_at?: string | null;
  finished_at?: string | null;
  can_resume?: boolean;
  last_activity_at?: string | null;
  resume_from_task_id?: string | null;
  latest_resume_task_id?: string | null;
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
  material_batch_id?: string | null;
  ingest_origin?: string;
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

export type ModelPreviewStatus =
  | "STARTING"
  | "STREAMING"
  | "RECONNECTING"
  | "STOPPING"
  | "STOPPED"
  | "FAILED";

export type ModelPreviewSession = {
  sessionId: string;
  status: ModelPreviewStatus;
  streamPath: string;
  createdAt: string;
};

export type ModelPreviewSnapshot = {
  sessionId: string;
  status: ModelPreviewStatus;
  modelName: string;
  frameWidth: number | null;
  frameHeight: number | null;
  inferenceFps: number;
  lastInferenceMs: number | null;
  detectionCount: number;
  classCounts: Record<string, number>;
  lastFrameAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
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
  metadata?: string[];
  project_name?: string | null;
  project_id?: string | null;
  model_id?: string | null;
  preview_frame_id?: string | null;
  has_cover?: boolean;
};
export type ModelCatalog = { stats: ModelCatalogStat[]; models: ModelCatalogItem[]; total: number };

export type VlmProfile = {
  id: string;
  name: string;
  model: string;
  base_url: string;
  cost_per_image: number;
  enabled: boolean;
};

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
  material_batch_id: string | null;
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

export type MaterialBatch = {
  id: string;
  project_id: string;
  origin: "video" | "image_upload" | "public_dataset" | "dataset_import" | "derived" | "legacy";
  title: string;
  status: "processing" | "action_required" | "ready" | "failed" | "archived";
  frame_count: number;
  usable_frame_count: number;
  pending_frame_count: number;
  frame_status_counts: Record<string, number>;
  preview_frame_ids: string[];
  metadata: Record<string, unknown>;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  next_action: string | null;
};

export type MaterialInventory = {
  summary: {
    active_batch_count: number;
    archived_batch_count: number;
    usable_frame_count: number;
    pending_batch_count: number;
    intake_blocking_batch_count: number;
    review_batch_count: number;
    review_sample_count: number;
    first_review_import_id: string | null;
    counts_by_origin: Record<string, number>;
  };
  items: MaterialBatch[];
};

export type MaterialFramePage = {
  items: Array<{ id: string; filename: string; status: string; split: string; created_at: string }>;
  total: number;
  offset: number;
  limit: number;
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
  datasetVersionCoverUrl: (projectId: string, versionId: string) =>
    withAuthQuery(`${getApiBase()}/api/projects/${projectId}/dataset-versions/${versionId}/cover`),
  openDatasetVersion: (projectId: string, versionId: string) =>
    request<{ ok: boolean; path: string }>(
      `/api/projects/${projectId}/dataset-versions/${versionId}/open`,
      { method: "POST" },
    ),
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
      const token = getAuthToken();
      if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
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
    return request<{ uploaded: number; material_batch_id: string }>(`/api/projects/${projectId}/images/upload`, {
      method: "POST",
      body: fd,
    });
  },
  uploadImagesWithProgress: (
    projectId: string,
    files: File[],
    onProgress: (pct: number) => void,
    split = "train",
  ) =>
    new Promise<{ uploaded: number; material_batch_id: string }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${getApiBase()}/api/projects/${projectId}/images/upload`);
      xhr.timeout = 10 * 60 * 1000;
      const token = getAuthToken();
      if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
      };
      xhr.upload.onload = () => onProgress(100);
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText));
          } catch {
            reject(new Error("解析上传结果失败"));
          }
          return;
        }
        try {
          const error = JSON.parse(xhr.responseText);
          const detail = typeof error.detail === "string" ? error.detail : error.error;
          reject(new Error(detail || xhr.statusText || "上传失败"));
        } catch {
          reject(new Error(xhr.statusText || "上传失败"));
        }
      };
      xhr.onerror = () => reject(new Error("网络中断，上传失败"));
      xhr.ontimeout = () => reject(new Error("上传或解压处理超时，请重试"));
      const fd = new FormData();
      files.forEach((file) => fd.append("files", file));
      fd.append("split", split);
      xhr.send(fd);
    }),

  listFrames: (projectId: string, status?: string, sort = "uncertainty", limit = 0) =>
    request<Frame[]>(
      `/api/projects/${projectId}/frames?sort=${sort}${status ? `&status=${status}` : ""}${limit ? `&limit=${limit}` : ""}`
    ),
  listFramesPage: (
    projectId: string,
    statuses: string[],
    cursor?: string | null,
    sort = "uncertainty",
    options?: { publicImportId?: string },
  ) => {
    const query = new URLSearchParams({ statuses: statuses.join(","), sort, limit: "100" });
    if (cursor) query.set("cursor", cursor);
    if (options?.publicImportId) query.set("public_import_id", options.publicImportId);
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
      {
        method: "POST",
        body: JSON.stringify({ query, roboflow_url: roboflowUrl }),
        timeoutMs: DISCOVER_TIMEOUT_MS,
      },
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
      timeoutMs: PUBLIC_FETCH_TIMEOUT_MS,
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
  approvePublicDatasetReview: (projectId: string, importId: string) =>
    request<PublicDatasetImport>(`/api/projects/${projectId}/public-dataset-imports/${importId}/approve-review`, {
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
  listMaterialBatches: (
    projectId: string,
    filters: { includeArchived?: boolean; origin?: string; status?: string; query?: string } = {},
  ) => {
    const query = new URLSearchParams();
    if (filters.includeArchived) query.set("include_archived", "true");
    if (filters.origin) query.set("origin", filters.origin);
    if (filters.status) query.set("status", filters.status);
    if (filters.query) query.set("query", filters.query);
    const suffix = query.toString() ? `?${query.toString()}` : "";
    return request<MaterialInventory>(`/api/projects/${projectId}/material-batches${suffix}`);
  },
  listMaterialBatchFrames: (projectId: string, batchId: string, offset = 0, limit = 40) =>
    request<MaterialFramePage>(
      `/api/projects/${projectId}/material-batches/${batchId}/frames?offset=${offset}&limit=${limit}`,
    ),
  archiveMaterialBatch: (projectId: string, batchId: string) =>
    request<{ id: string; archived_at: string | null }>(
      `/api/projects/${projectId}/material-batches/${batchId}/archive`,
      { method: "POST" },
    ),
  restoreMaterialBatch: (projectId: string, batchId: string) =>
    request<{ id: string; archived_at: string | null }>(
      `/api/projects/${projectId}/material-batches/${batchId}/restore`,
      { method: "POST" },
    ),
  frameImageUrl: (
    projectId: string,
    frameId: string,
    annotated = false,
    options?: { maxEdge?: number },
  ) => {
    const params = new URLSearchParams({ annotated: String(annotated) });
    if (options?.maxEdge && options.maxEdge > 0) {
      params.set("max_edge", String(options.maxEdge));
    }
    return withAuthQuery(
      `${getApiBase()}/api/projects/${projectId}/frames/${frameId}/image?${params.toString()}`,
    );
  },
  modelCoverUrl: (projectId: string, modelId: string) =>
    withAuthQuery(`${getApiBase()}/api/projects/${projectId}/models/${modelId}/cover`),
  frameFeedback: (projectId: string, frameId: string, status: string, note = "") =>
    request(`/api/projects/${projectId}/frames/${frameId}/feedback`, {
      method: "POST",
      body: JSON.stringify({ status, note }),
    }),
  batchFrameFeedback: (
    projectId: string,
    fromStatuses: string[],
    status = "human_ok",
    options?: { publicImportId?: string },
  ) =>
    request<{ ok: boolean; updated: number }>(`/api/projects/${projectId}/frames/batch-feedback`, {
      method: "POST",
      body: JSON.stringify({
        from_statuses: fromStatuses,
        status,
        public_import_id: options?.publicImportId,
      }),
    }),
  updateAnnotations: (projectId: string, frameId: string, annotations: Annotation[], status = "human_ok") =>
    request(`/api/projects/${projectId}/frames/${frameId}/annotations`, {
      method: "PUT",
      body: JSON.stringify({ annotations, status }),
    }),
  labelEstimate: (projectId: string, vlmProfileId?: string) => {
    const query = vlmProfileId ? `?vlm_profile_id=${encodeURIComponent(vlmProfileId)}` : "";
    return request<{ frame_count: number; cost_per_image: number; estimated_cost: number }>(
      `/api/projects/${projectId}/label/estimate${query}`,
    );
  },
  suggestTrainParams: (projectId: string, body: { dataset_version_id?: string } = {}) =>
    request<{
      params: {
        epochs: number;
        imgsz: number;
        batch: number;
        base_model: string;
        workers: number;
        patience: number;
        lr0: number;
        optimizer: string;
        seed: number;
        close_mosaic: number;
        weight_decay: number;
        warmup_epochs: number;
      };
      reason: string;
      source: "llm" | "heuristic" | string;
    }>(`/api/projects/${projectId}/suggest/train-params`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

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
  resumeTrainTask: (projectId: string, taskId: string, params?: Record<string, unknown>) =>
    request<Task>(`/api/projects/${projectId}/tasks/${taskId}/resume`, {
      method: "POST",
      body: JSON.stringify({ params: params ?? {} }),
    }),

  listModels: (projectId: string) => request<ModelVersion[]>(`/api/projects/${projectId}/models`),
  listBaseModelCandidates: (taskType?: string) => {
    const query = taskType ? `?task_type=${encodeURIComponent(taskType)}` : "";
    return request<
      Array<{
        id: string;
        project_id: string;
        project_name: string;
        version: number;
        name: string;
        filepath: string;
        task_type: string;
        origin: string;
        created_at: string;
      }>
    >(`/api/models/base-candidates${query}`);
  },
  listBuiltinModels: (taskType?: string) => {
    const query = taskType ? `?task_type=${encodeURIComponent(taskType)}` : "";
    return request<
      Array<{ key: string; name: string; hint: string; filename: string; task: string; cached: boolean }>
    >(`/api/models/builtin${query}`);
  },
  registerBuiltinModels: (projectId: string, keys?: string[]) =>
    request<{
      ok: boolean;
      created: ModelVersion[];
      skipped_keys: string[];
      downloaded: string[];
      task_type: string;
    }>(`/api/projects/${projectId}/models/register-builtin`, {
      method: "POST",
      body: JSON.stringify(keys?.length ? { keys } : {}),
      timeoutMs: 600_000,
    }),
  uploadModel: (projectId: string, file: File, name = "", cover?: File | null) => {
    const fd = new FormData();
    fd.append("file", file);
    if (name) fd.append("name", name);
    if (cover) fd.append("cover", cover);
    return request<ModelVersion>(`/api/projects/${projectId}/models/upload`, {
      method: "POST",
      body: fd,
      // 权重常 >10MB：浏览器直连后端，避开 Next 代理默认 10MB 截断
      apiBase: typeof window !== "undefined" ? RUNTIME.apiOrigin : undefined,
      // 权重文件常达数十到数百 MB，放宽至 10 分钟
      timeoutMs: 10 * 60 * 1000,
    });
  },
  deleteModel: (projectId: string, modelId: string) =>
    request<{ ok: boolean; id: string }>(`/api/projects/${projectId}/models/${modelId}`, {
      method: "DELETE",
    }),
  predictModel: (projectId: string, modelId: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return request<{ boxes: Array<{ class_id: number; x: number; y: number; w: number; h: number; conf: number }> }>(
      `/api/projects/${projectId}/models/predict?model_id=${encodeURIComponent(modelId)}`,
      { method: "POST", body: fd },
    );
  },
  createModelPreview: (
    projectId: string,
    modelId: string,
    body: { rtspUrl: string; confidenceThreshold: number; inferenceFps: number },
  ) => request<ModelPreviewSession>(
    `/api/projects/${projectId}/models/${modelId}/preview-sessions`,
    { method: "POST", body: JSON.stringify(body) },
  ),
  getModelPreview: (projectId: string, modelId: string, sessionId: string) =>
    request<ModelPreviewSnapshot>(
      `/api/projects/${projectId}/models/${modelId}/preview-sessions/${sessionId}`,
    ),
  stopModelPreview: (
    projectId: string,
    modelId: string,
    sessionId: string,
    options?: { keepalive?: boolean },
  ) => request<ModelPreviewSnapshot>(
    `/api/projects/${projectId}/models/${modelId}/preview-sessions/${sessionId}`,
    { method: "DELETE", keepalive: options?.keepalive },
  ),
  modelPreviewStreamUrl: (streamPath: string) =>
    withAuthQuery(`${getApiBase()}${streamPath}`),

  getSettings: () =>
    request<{
      dashscope_api_key_set: boolean;
      vlm_model: string;
      vlm_base_url: string;
      vlm_max_concurrency: number;
      vlm_cost_per_image: number;
      vlm_profiles: VlmProfile[];
      default_vlm_id: string;
    }>("/api/settings"),
  updateSettings: (body: Record<string, unknown>) =>
    request<{
      dashscope_api_key_set: boolean;
      vlm_model: string;
      vlm_base_url: string;
      vlm_max_concurrency: number;
      vlm_cost_per_image: number;
      vlm_profiles: VlmProfile[];
      default_vlm_id: string;
    }>("/api/settings", { method: "PUT", body: JSON.stringify(body) }),

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
