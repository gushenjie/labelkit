"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { YoloLabelPanel } from "@/components/YoloLabelPanel";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, PanelSection } from "@/components/ui/Panel";
import { useToast } from "@/components/ui/ToastProvider";
import { api, ModelVersion, Project } from "@/lib/api";
import { Icon } from "@/components/Icon";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8010";

function modelOrigin(m: ModelVersion): string {
  const origin = (m.metrics as { origin?: string })?.origin;
  if (origin === "upload") return "外部上传";
  if (Object.keys(m.metrics).length > 0) return "平台训练";
  return "未知";
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

  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [models, setModels] = useState<ModelVersion[]>([]);
  const [stats, setStats] = useState<Record<string, number>>({});
  const [uploading, setUploading] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState("");

  const [trialModelId, setTrialModelId] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [trialResult, setTrialResult] = useState<{
    boxes: Array<{ class_id: number; x: number; y: number; w: number; h: number; conf: number }>;
  } | null>(null);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    const [m, s] = await Promise.all([api.listModels(projectId), api.frameStats(projectId)]);
    setModels(m);
    setStats(s);
    setTrialModelId((prev) => (prev && m.find((x) => x.id === prev) ? prev : m[0]?.id ?? ""));
  }, [projectId]);

  const loadProjects = useCallback(async () => {
    const list = await api.listProjects();
    setProjects(list);
    setProjectId((prev) => {
      if (projectParam && list.find((p) => p.id === projectParam)) return projectParam;
      if (prev && list.find((p) => p.id === prev)) return prev;
      return list[0]?.id ?? "";
    });
  }, [projectParam]);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    refresh();
  }, [refresh]);

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
    setPreview(URL.createObjectURL(file));
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(`${API_BASE}/api/projects/${projectId}/models/predict?model_id=${trialModelId}`, {
      method: "POST",
      body: fd,
    });
    if (!res.ok) {
      setTrialResult(null);
      return;
    }
    setTrialResult(await res.json());
  };

  const currentProject = projects.find((p) => p.id === projectId);

  return (
    <div className="operations-page model-library-page">
      <PageHeader
        title="模型库"
        description="按项目管理 YOLO 模型：上传 .pt、半自动打标、在线试用"
        eyebrow="Model registry"
        action={
          currentProject ? (
            <Link href={`/projects/${projectId}`} className="btn-secondary">
              <Icon name="chevron-left" size={15} />
              返回项目
            </Link>
          ) : (
            <Link href="/" className="btn-secondary">
              <Icon name="chevron-left" size={15} />
              返回首页
            </Link>
          )
        }
      />

      {projects.length === 0 ? (
        <Panel>
          <PanelSection>
            <p className="mb-4 text-center text-muted">还没有项目，先创建一个再上传模型</p>
            <div className="text-center">
              <Link href="/?create=1" className="btn-primary">新建项目</Link>
            </div>
          </PanelSection>
        </Panel>
      ) : (
        <>
          <section className="model-project-bar">
            <div>
              <span className="project-section-kicker">Active project</span>
              <strong>模型归属项目</strong>
            </div>
            <select className="input" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <div className="model-project-bar__metrics">
              <span><strong>{models.length}</strong>模型版本</span>
              <span><strong>{stats.total ?? 0}</strong>数据帧</span>
              <span><strong>{stats.human_wrong ?? 0}</strong>待修正</span>
            </div>
          </section>

          <div className="model-library-grid">
            <Panel className="model-upload-panel">
              <PanelSection title="上传模型权重">
              {error && <p className="mb-2 text-sm text-danger-600">{error}</p>}
              <div className="model-upload-panel__intro">
                <span><Icon name="upload" size={19} /></span>
                <div>
                  <strong>导入 YOLO .pt 文件</strong>
                  <p>上传后自动归档到当前项目，可用于标注修正和在线试用。</p>
                </div>
              </div>
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

            <Panel className="model-registry-panel">
              <PanelSection title={`模型列表 (${models.length})`}>
              {models.length === 0 ? (
                <div className="model-registry-empty">
                  <span><Icon name="package" size={20} /></span>
                  <strong>该项目暂无模型</strong>
                  <p>上传权重或从训练导出页启动模型训练。</p>
                </div>
              ) : (
                <ul className="model-registry-list">
                  {models.map((m) => (
                    <li key={m.id}>
                      <span><Icon name="package" size={16} /></span>
                      <div><strong>{m.name}</strong><small>版本 v{m.version}</small></div>
                      <em>{modelOrigin(m)}</em>
                    </li>
                  ))}
                </ul>
              )}
              </PanelSection>
            </Panel>
          </div>

          {projectId && models.length > 0 && (
            <Panel className="model-correction-panel">
              <PanelSection title="驳回修正">
              <p className="mb-3 text-sm text-muted">
                对已驳回图片用模型批量修正 · 未标注图片请前往项目的「自动标注」页
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

          {models.length > 0 && (
            <Panel className="model-trial-panel">
              <PanelSection title="在线试用">
              <p className="mb-3 text-sm text-muted">单张图测试检出效果（不写入标注）</p>
              <div className="mb-3 flex flex-wrap gap-3">
                <select className="input max-w-xs text-sm" value={trialModelId} onChange={(e) => setTrialModelId(e.target.value)}>
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>{m.name}</option>
                  ))}
                </select>
                <input
                  type="file"
                  accept="image/*"
                  className="input max-w-xs text-sm"
                  disabled={!trialModelId}
                  onChange={(e) => e.target.files?.[0] && runTrial(e.target.files[0])}
                />
              </div>
              {preview && (
                <>
                  <img src={preview} alt="trial" className="max-h-80 rounded-lg border border-border" />
                  {trialResult && (
                    <pre className="mt-3 max-h-40 overflow-auto text-xs text-muted">
                      {JSON.stringify(trialResult, null, 2)}
                    </pre>
                  )}
                </>
              )}
              </PanelSection>
            </Panel>
          )}
        </>
      )}
    </div>
  );
}
