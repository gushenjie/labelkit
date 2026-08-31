import { resolveApiBase } from "./api-base";

/** 浏览器未配置时走同源 /api 代理；SSR 回退本机后端 */
export function getApiBase(): string {
  if (typeof window !== "undefined") {
    return resolveApiBase();
  }
  return resolveApiBase() || "http://127.0.0.1:8010";
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${getApiBase()}${path}`, {
    ...options,
    headers: {
      ...(options?.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || err.error || res.statusText);
  }
  return res.json();
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
  created_at: string;
  updated_at: string;
};

export type ProjectOverview = {
  project: Project;
  stats: Record<string, number>;
  preview_frame_id: string | null;
  model_count: number;
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

export type GlobalTask = Task & { project_name: string };

export type Video = {
  id: string;
  filename: string;
  duration_sec: number | null;
  fps: number | null;
  frame_count: number | null;
  split: string;
  extracted_count?: number;
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
  listProjects: () => request<Project[]>("/api/projects"),
  listProjectOverviews: () => request<ProjectOverview[]>("/api/projects/overview"),
  createProject: (body: Partial<Project> & { categories?: Category[] }) =>
    request<Project>("/api/projects", { method: "POST", body: JSON.stringify(body) }),
  getProject: (id: string) => request<Project>(`/api/projects/${id}`),
  updateProject: (id: string, body: Partial<Project>) =>
    request<Project>(`/api/projects/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteProject: (id: string) => request(`/api/projects/${id}`, { method: "DELETE" }),
  setCategories: (id: string, categories: Category[]) =>
    request<Category[]>(`/api/projects/${id}/categories`, {
      method: "PUT",
      body: JSON.stringify(categories),
    }),

  listVideos: (projectId: string) => request<Video[]>(`/api/projects/${projectId}/videos`),
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
  discardPublicDataset: (projectId: string, importId: string) =>
    request<{ ok: boolean; removed_frames: number }>(
      `/api/projects/${projectId}/public-dataset-imports/${importId}/discard`,
      { method: "POST" },
    ),
  frameStats: (projectId: string) =>
    request<Record<string, number>>(`/api/projects/${projectId}/frames/stats`),
  frameImageUrl: (projectId: string, frameId: string, annotated = false) =>
    `${getApiBase()}/api/projects/${projectId}/frames/${frameId}/image?annotated=${annotated}`,
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

  pickFolder: () => request<{ path: string }>("/api/system/pick-folder", { method: "POST" }),
  openPath: (path: string) =>
    request<{ ok: boolean; path: string }>("/api/system/open-path", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),
};
