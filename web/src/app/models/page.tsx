"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ModelTrialPreview, type TrialBox } from "@/components/ModelTrialPreview";
import { YoloLabelPanel } from "@/components/YoloLabelPanel";
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

function readModelMetrics(metrics: Record<string, unknown>) {
  return {
    map50: formatTrainMetric(metrics, "metrics/mAP50(B)", "mAP50", "map50"),
    precision: formatTrainMetric(metrics, "metrics/precision(B)", "precision"),
    recall: formatTrainMetric(metrics, "metrics/recall(B)", "recall"),
  };
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
  const lastTrialFileRef = useRef<File | null>(null);

  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [loadProjectsError, setLoadProjectsError] = useState("");
  const [models, setModels] = useState<ModelVersion[]>([]);
  const [stats, setStats] = useState<Record<string, number>>({});

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
    } catch {
      // 刷新失败时保留当前列表
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

  const runTrial = useCallback(async (file: File, modelId?: string) => {
    const activeModelId = modelId ?? trialModelId;
    if (!projectId || !activeModelId) return;
    lastTrialFileRef.current = file;
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
        `${getApiBase()}/api/projects/${projectId}/models/predict?model_id=${activeModelId}`,
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
  }, [projectId, trialModelId, toast]);

  const selectModel = useCallback((modelId: string) => {
    setTrialModelId(modelId);
    const cached = lastTrialFileRef.current;
    if (cached) {
      void runTrial(cached, modelId);
    }
  }, [runTrial]);

  const currentProject = projects.find((p) => p.id === projectId);
  const activeModel = models.find((m) => m.id === trialModelId) ?? models[0];
  const activeMetrics = useMemo(
    () => readModelMetrics(activeModel?.metrics ?? {}),
    [activeModel],
  );
  const rejectedCount = stats.human_wrong ?? 0;

  const trialSummary = trialLoading
    ? "正在分析…"
    : preview
      ? trialBoxes.length > 0
        ? `检测到 ${trialBoxes.length} 个目标`
        : "未检测到目标"
      : null;

  return (
    <div className="operations-page model-center-page">
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
          <div className="model-center__bar">
            <label className="model-center__project">
              <span>当前项目</span>
              {projects.length === 1 ? (
                <strong>{currentProject?.name}</strong>
              ) : (
                <select className="input" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              )}
            </label>
            <div className="model-center__bar-meta">
              <span>{stats.total ?? 0} 张素材</span>
              <span>{models.length} 个版本</span>
              {models.length > 0 && (
                <Link href={`/projects/${projectId}/train`} className="model-center__train-link">
                  训练与导出
                  <Icon name="chevron-right" size={14} />
                </Link>
              )}
            </div>
          </div>

          {models.length === 0 ? (
            <section className="model-center__empty" aria-label="模型库为空">
              <div className="model-center__empty-copy">
                <span><Icon name="package" size={28} /></span>
                <div>
                  <span className="model-center__empty-kicker">模型库</span>
                  <strong>该项目还没有模型</strong>
                  <p>完成训练后，模型版本会在这里沉淀，并可立即进行在线试用。</p>
                </div>
              </div>
              <div className="model-center__empty-action">
                <span>下一步</span>
                <strong>训练第一个模型</strong>
                <p>使用当前项目的已确认素材开始训练。</p>
                <Link href={`/projects/${projectId}/train`} className="btn-primary">去训练</Link>
              </div>
            </section>
          ) : (
            <div className="model-center__workspace">
              <aside className="model-center__rail" aria-label="模型版本与指标">
                <div className="model-center__rail-head">
                  <h2>版本</h2>
                  <span>{models.length}</span>
                </div>

                <ul className="model-version-picker" role="listbox" aria-label="选择模型版本">
                  {models.map((m) => {
                    const selected = m.id === trialModelId;
                    const { map50 } = readModelMetrics(m.metrics);
                    return (
                      <li key={m.id}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={selected}
                          className={selected ? "model-version-picker__item model-version-picker__item--active" : "model-version-picker__item"}
                          onClick={() => selectModel(m.id)}
                        >
                          <span className="model-version-picker__badge">v{m.version}</span>
                          <span className="model-version-picker__copy">
                            <strong>{m.name}</strong>
                            <small>{modelOrigin(m)}</small>
                          </span>
                          {map50 && <em>{map50}</em>}
                        </button>
                      </li>
                    );
                  })}
                </ul>

                {activeModel && (
                  <div className="model-center__metrics">
                    <p className="model-center__metrics-title">当前版本指标</p>
                    <div className="model-center__metrics-grid">
                      <div className={activeMetrics.map50 ? "model-center__metric" : "model-center__metric model-center__metric--muted"}>
                        <strong>{activeMetrics.map50 ?? "—"}</strong>
                        <span>mAP50</span>
                      </div>
                      <div className={activeMetrics.precision ? "model-center__metric" : "model-center__metric model-center__metric--muted"}>
                        <strong>{activeMetrics.precision ?? "—"}</strong>
                        <span>精确率</span>
                      </div>
                      <div className={activeMetrics.recall ? "model-center__metric" : "model-center__metric model-center__metric--muted"}>
                        <strong>{activeMetrics.recall ?? "—"}</strong>
                        <span>召回率</span>
                      </div>
                    </div>
                    <p className="model-center__metrics-note">
                      小样本指标波动大，请以在线试用为准
                    </p>
                  </div>
                )}

                {rejectedCount > 0 && (
                  <details className="model-advanced model-advanced--rail">
                    <summary>驳回修正</summary>
                    <div className="model-advanced__body">
                      <p className="model-advanced__hint">对已驳回的 {rejectedCount} 张图片用模型批量重打框</p>
                      <YoloLabelPanel
                        projectId={projectId}
                        frameStats={stats}
                        fixedOnlyStatus="human_wrong"
                        onDone={refresh}
                      />
                    </div>
                  </details>
                )}
              </aside>

              <section className="model-center__stage" aria-label="在线试用">
                <div className="model-center__stage-head">
                  <div>
                    <h2>在线试用</h2>
                    <p>上传或拖拽图片，即时预览检测框（不写入标注）</p>
                  </div>
                  <div className="model-center__stage-actions">
                    {activeModel && (
                      <span className="model-center__stage-version">
                        {activeModel.name} · v{activeModel.version}
                      </span>
                    )}
                    <label className="btn-primary model-trial-panel__upload model-center__upload">
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
                </div>

                <div className="model-center__stage-body">
                  <ModelTrialPreview
                    imageUrl={preview}
                    boxes={trialBoxes}
                    categories={currentProject?.categories ?? []}
                    loading={trialLoading}
                    onUpload={runTrial}
                    uploadDisabled={!trialModelId}
                    showSummary={false}
                  />
                  {trialSummary && (
                    <p className="model-center__stage-result" data-testid="model-trial-result">
                      {trialSummary}
                    </p>
                  )}
                </div>
              </section>
            </div>
          )}
        </>
      )}
    </div>
  );
}
