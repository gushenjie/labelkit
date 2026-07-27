const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8010";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
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

export type Category = {
  id?: string;
  class_id: number;
  name: string;
  description: string;
  color: string;
  required: boolean;
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
  created_at: string;
};

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
};

export const api = {
  listProjects: () => request<Project[]>("/api/projects"),
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
      xhr.open("POST", `${API_BASE}/api/projects/${projectId}/videos/upload`);
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
  frameStats: (projectId: string) =>
    request<Record<string, number>>(`/api/projects/${projectId}/frames/stats`),
  frameImageUrl: (projectId: string, frameId: string, annotated = false) =>
    `${API_BASE}/api/projects/${projectId}/frames/${frameId}/image?annotated=${annotated}`,
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
