"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ModelTrialPreview, type TrialBox } from "@/components/ModelTrialPreview";
import { YoloLabelPanel } from "@/components/YoloLabelPanel";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, PanelSection } from "@/components/ui/Panel";
import { useToast } from "@/components/ui/ToastProvider";
import { api, getApiBase, ModelVersion, Project } from "@/lib/api";
import { Icon } from "@/components/Icon";

function modelOrigin(m: ModelVersion): string {
  const origin = (m.metrics as { origin?: string })?.origin;
  if (origin === "upload") return "外部上传";
  if (Object.keys(m.metrics).length > 0) return "平台训练";
  return "未知";
}

function formatTrainMetric(metrics: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const raw = metrics[key];
    if (typeof raw === "number" && !Number.isNaN(raw)) {
      return `${(raw * 100).toFixed(1)}%`;
    }
  }
  return null;
}

export default function GlobalModelsPage() {
  return (
    <Suspense fallback={<p className="p-6 text-subtle">加载中…</p>}>
      <GlobalModelsPageInner />
    </Suspense>
  );
}

function GlobalModelsPageInner() {
  const searchParams = useSearchParams();
  const projectParam = searchParams.get("project");
  const { toast } = useToast();
  const previewUrlRef = useRef<string | null>(null);

  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [loadProjectsError, setLoadProjectsError] = useState("");
  const [models, setModels] = useState<ModelVersion[]>([]);
  const [stats, setStats] = useState<Record<string, number>>({});
  const [uploading, setUploading] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState("");

  const [trialModelId, setTrialModelId] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [trialBoxes, setTrialBoxes] = useState<TrialBox[]>([]);
  const [trialLoading, setTrialLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    try {
      const [m, s] = await Promise.all([api.listModels(projectId), api.frameStats(projectId)]);
      setModels(m);
      setStats(s);
      setTrialModelId((prev) => (prev && m.find((x) => x.id === prev) ? prev : m[0]?.id ?? ""));
    } catch (e) {
      setError(String(e));
    }
  }, [projectId]);

  const loadProjects = useCallback(async () => {
    setLoadingProjects(true);
    setLoadProjectsError("");
    try {
      const overviews = await api.listProjectOverviews();
      let list = overviews.map((item) => item.project);
      if (list.length === 0 && projectParam) {
        try {
          list = [await api.getProject(projectParam)];
        } catch {
          // 列表为空且指定项目不存在时保持空列表
        }
      }
      setProjects(list);
      setProjectId((prev) => {
        if (projectParam && list.find((p) => p.id === projectParam)) return projectParam;
        if (prev && list.find((p) => p.id === prev)) return prev;
        return list[0]?.id ?? "";
      });
    } catch (e) {
      setProjects([]);
      setProjectId("");
      setLoadProjectsError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingProjects(false);
    }
  }, [projectParam]);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => () => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
  }, []);

  const handleUpload = async (file: File) => {
    if (!projectId) return;
    setUploading(true);
    setError("");
    try {
      await api.uploadModel(projectId, file, displayName.trim());
      setDisplayName("");
      await refresh();
      toast({ type: "success", message: "模型上传成功" });
    } catch (e) {
      setError(String(e));
      toast({ type: "error", message: String(e) });
    } finally {
      setUploading(false);
    }
  };

  const runTrial = async (file: File) => {
    if (!projectId || !trialModelId) return;
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    const nextPreview = URL.createObjectURL(file);
    previewUrlRef.current = nextPreview;
    setPreview(nextPreview);
    setTrialBoxes([]);
    setTrialLoading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(
        `${getApiBase()}/api/projects/${projectId}/models/predict?model_id=${trialModelId}`,
        { method: "POST", body: fd },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }));
        throw new Error(err.detail || res.statusText);
      }
      const data = await res.json() as { boxes: TrialBox[] };
      setTrialBoxes(data.boxes ?? []);
    } catch (e) {
      setTrialBoxes([]);
      toast({ type: "error", message: `检测失败：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setTrialLoading(false);
    }
  };

  const currentProject = projects.find((p) => p.id === projectId);
  const latestModel = models[0];
  const rejectedCount = stats.human_wrong ?? 0;
  const modelMetrics = latestModel?.metrics ?? {};
  const map50 = formatTrainMetric(modelMetrics, "metrics/mAP50(B)", "mAP50", "map50");
  const precision = formatTrainMetric(modelMetrics, "metrics/precision(B)", "precision");
  const recall = formatTrainMetric(modelMetrics, "metrics/recall(B)", "recall");

  const advancedHint = useMemo(() => {
    const parts = ["上传外部权重"];
    if (rejectedCount > 0) parts.push("驳回修正");
    return parts.join("、");
  }, [rejectedCount]);

  return (
    <div className="operations-page model-library-page model-library-page--focused">
      <PageHeader
        title="模型中心"
        description="选择项目、在线试用检测效果；训练与导出在对应项目页完成"
        eyebrow="Model center"
        action={
          currentProject ? (
            <Link href={`/projects/${projectId}/train`} className="btn-secondary">
              <Icon name="chevron-left" size={15} />
              训练与导出
            </Link>
          ) : (
            <Link href="/" className="btn-secondary">
              <Icon name="chevron-left" size={15} />
              返回首页
            </Link>
          )
        }
      />

      {loadingProjects ? (
        <Panel>
          <PanelSection>
            <p className="text-center text-muted">正在加载项目…</p>
          </PanelSection>
        </Panel>
      ) : loadProjectsError ? (
        <Panel>
          <PanelSection>
            <p className="mb-2 text-center text-danger-600">项目加载失败：{loadProjectsError}</p>
            <div className="text-center">
              <button type="button" className="btn-primary" onClick={() => loadProjects()}>重试</button>
            </div>
          </PanelSection>
        </Panel>
      ) : projects.length === 0 ? (
        <Panel>
          <PanelSection>
            <p className="mb-4 text-center text-muted">还没有项目，先创建并完成训练后再来试用模型</p>
            <div className="text-center">
              <Link href="/?create=1" className="btn-primary">新建项目</Link>
            </div>
          </PanelSection>
        </Panel>
      ) : (
        <>
          <section className="model-hero">
            <div className="model-hero__project">
              <span className="project-section-kicker">Current project</span>
              {projects.length === 1 ? (
                <strong>{currentProject?.name}</strong>
              ) : (
                <select className="input" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              )}
            </div>

            {models.length === 0 ? (
              <div className="model-hero__empty">
                <strong>该项目还没有模型</strong>
                <p>完成训练后会自动出现在这里</p>
                <Link href={`/projects/${projectId}/train`} className="btn-primary">去训练</Link>
              </div>
            ) : (
              <div className="model-hero__card">
                <span><Icon name="package" size={18} /></span>
                <div>
                  <strong>{latestModel?.name ?? "—"}</strong>
                  <small>版本 v{latestModel?.version} · {modelOrigin(latestModel!)}</small>
                </div>
                <div className="model-hero__stats">
                  {map50 && <span><em>mAP50</em><strong>{map50}</strong></span>}
                  {precision && <span><em>精确率</em><strong>{precision}</strong></span>}
                  {recall && <span><em>召回率</em><strong>{recall}</strong></span>}
                  <span><em>版本数</em><strong>{models.length}</strong></span>
                  <span><em>数据帧</em><strong>{stats.total ?? 0}</strong></span>
                </div>
              </div>
            )}
          </section>

          {models.length > 0 && (
            <Panel className="model-trial-panel model-trial-panel--primary">
              <PanelSection title="在线试用">
                <p className="model-trial-panel__lead">上传一张图片，即时查看检测框（不写入标注）</p>
                <div className="model-trial-panel__toolbar">
                  {models.length > 1 && (
                    <label className="model-trial-panel__field">
                      <span>模型版本</span>
                      <select className="input text-sm" value={trialModelId} onChange={(e) => setTrialModelId(e.target.value)}>
                        {models.map((m) => (
                          <option key={m.id} value={m.id}>{m.name} (v{m.version})</option>
                        ))}
                      </select>
                    </label>
                  )}
                  <label className="model-trial-panel__upload btn-primary">
                    <Icon name="upload" size={15} />
                    {trialLoading ? "检测中…" : "选择图片"}
                    <input
                      type="file"
                      accept="image/*"
                      className="sr-only"
                      disabled={!trialModelId || trialLoading}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) runTrial(file);
                        e.target.value = "";
                      }}
                    />
                  </label>
                </div>
                <ModelTrialPreview
                  imageUrl={preview}
                  boxes={trialBoxes}
                  categories={currentProject?.categories ?? []}
                  loading={trialLoading}
                  onUpload={runTrial}
                  uploadDisabled={!trialModelId}
                />
              </PanelSection>
            </Panel>
          )}

          {models.length > 1 && (
            <Panel className="model-versions-panel">
              <PanelSection title={`全部版本 (${models.length})`}>
                <ul className="model-registry-list model-registry-list--compact">
                  {models.map((m) => (
                    <li key={m.id}>
                      <span><Icon name="package" size={16} /></span>
                      <div><strong>{m.name}</strong><small>v{m.version}</small></div>
                      <em>{modelOrigin(m)}</em>
                    </li>
                  ))}
                </ul>
              </PanelSection>
            </Panel>
          )}

          <details className="model-advanced">
            <summary>{advancedHint}</summary>
            <div className="model-advanced__body">
              <Panel className="model-upload-panel">
                <PanelSection title="上传外部模型">
                  {error && <p className="mb-2 text-sm text-danger-600">{error}</p>}
                  <p className="model-advanced__hint">导入第三方 YOLO .pt 权重，归档到当前项目</p>
                  <input
                    className="input mb-2 text-sm"
                    placeholder="显示名称（可选）"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                  />
                  <input
                    type="file"
                    accept=".pt"
                    className="input text-sm"
                    disabled={uploading || !projectId}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) handleUpload(f);
                      e.target.value = "";
                    }}
                  />
                  {uploading && <p className="mt-2 text-xs text-subtle">上传中…</p>}
                </PanelSection>
              </Panel>

              {rejectedCount > 0 && (
                <Panel className="model-correction-panel">
                  <PanelSection title="驳回修正">
                    <p className="model-advanced__hint">
                      对已驳回的 {rejectedCount} 张图片用模型批量重打框
                    </p>
                    <YoloLabelPanel
                      projectId={projectId}
                      frameStats={stats}
                      fixedOnlyStatus="human_wrong"
                      onDone={refresh}
                    />
                  </PanelSection>
                </Panel>
              )}
            </div>
          </details>
        </>
      )}
    </div>
  );
}
