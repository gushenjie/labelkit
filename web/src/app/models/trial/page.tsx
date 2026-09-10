"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Icon } from "@/components/Icon";
import { ModelTrialPreview, type TrialBox } from "@/components/ModelTrialPreview";
import { ModelRealtimePreview } from "@/components/ModelRealtimePreview";
import { api, type Category } from "@/lib/api";

export default function ModelTrialPage() {
  const searchParams = useSearchParams();
  const projectId = searchParams.get("projectId") ?? "";
  const modelId = searchParams.get("modelId") ?? "";
  const name = searchParams.get("name") ?? "训练模型";
  const version = searchParams.get("version") ?? "";
  const inputRef = useRef<HTMLInputElement>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [boxes, setBoxes] = useState<TrialBox[]>([]);
  const [fileName, setFileName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const [trialMode, setTrialMode] = useState<"image" | "realtime">("image");

  useEffect(() => {
    if (!projectId) return;
    api.getProject(projectId).then((project) => setCategories(project.categories)).catch(() => setError("未能读取项目类别，请返回模型中心后重试。"));
  }, [projectId]);

  useEffect(() => () => { if (imageUrl) URL.revokeObjectURL(imageUrl); }, [imageUrl]);

  const runPredict = async (file: File) => {
    if (!file.type.startsWith("image/")) { setError("请选择 JPG、PNG 等图片文件。"); return; }
    const nextUrl = URL.createObjectURL(file);
    setImageUrl((current) => { if (current) URL.revokeObjectURL(current); return nextUrl; });
    setFileName(file.name);
    setBoxes([]);
    setError("");
    setElapsedMs(null);
    setLoading(true);
    const startedAt = performance.now();
    try {
      const result = await api.predictModel(projectId, modelId, file);
      setBoxes(result.boxes);
      setElapsedMs(Math.round(performance.now() - startedAt));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "模型推理失败，请重试。");
    } finally {
      setLoading(false);
    }
  };

  const ready = Boolean(projectId && modelId);
  const resultState = !imageUrl ? "empty" : loading ? "loading" : error ? "error" : "complete";
  const versionLabel = version && version !== name ? version : "";
  const maxConfidence = boxes.length ? Math.max(...boxes.map((box) => box.conf)) : 0;
  const visibleBoxes = boxes.slice(0, 6);

  const categoryFor = (classId: number) => categories.find((item) => item.class_id === classId);

  const chooseImage = () => inputRef.current?.click();

  const fileInput = (
    <input
      ref={inputRef}
      className="model-trial-file-input"
      type="file"
      accept="image/jpeg,image/png,image/webp"
      onChange={(event) => {
        const file = event.target.files?.[0];
        if (file) void runPredict(file);
        event.currentTarget.value = "";
      }}
    />
  );

  return (
    <main className="model-trial-page">
      <header className="model-trial-page__header">
        <div className="model-trial-page__title-row">
          <div className="model-trial-page__copy">
            <h1>在线测试</h1>
            <p>{trialMode === "image" ? "上传图片，查看模型返回的目标框与置信度。" : "连接单路摄像头，实时查看模型检测结果。"}</p>
          </div>
          <div className="model-trial-mode-switch" role="tablist" aria-label="模型试用方式">
            <button type="button" role="tab" aria-selected={trialMode === "image"} className={trialMode === "image" ? "is-active" : ""} onClick={() => setTrialMode("image")}>
              <Icon name="image" size={15} />图片测试
            </button>
            <button type="button" role="tab" aria-selected={trialMode === "realtime"} className={trialMode === "realtime" ? "is-active" : ""} onClick={() => setTrialMode("realtime")}>
              <Icon name="video" size={15} />实时预览
            </button>
          </div>
          <div className="model-trial-page__current-model">
            <span className="model-trial-page__model-icon"><Icon name="cube" size={21} /></span>
            <div><small>测试模型</small><strong title={name}>{name}</strong></div>
            {versionLabel && <span className="model-trial-page__version">{versionLabel}</span>}
            <span className="model-trial-page__type">目标检测</span>
          </div>
        </div>
      </header>

      {!ready ? (
        <section className="model-trial-page__notice">
          <Icon name="package" size={28} />
          <div><strong>缺少模型上下文</strong><p>请从训练模型卡片点击“在线测试”进入此页面。</p></div>
          <Link href="/models">返回模型中心<Icon name="arrow-right" size={15} /></Link>
        </section>
      ) : trialMode === "realtime" ? (
        <ModelRealtimePreview
          projectId={projectId}
          modelId={modelId}
          categories={categories}
        />
      ) : (
        <section className={`model-trial-workspace model-trial-workspace--${resultState}`}>
          {fileInput}
          <div className="model-trial-result-layout">
            <section className="model-trial-image-panel">
              <header className="model-trial-panel-header">
                <div><span>测试图片</span><strong title={fileName}>{fileName || "尚未选择图片"}</strong></div>
                {imageUrl && <button type="button" className="model-trial-change-button" disabled={loading} onClick={chooseImage}>
                  <Icon name={loading ? "refresh" : "upload"} size={16} />{loading ? "检测中…" : "更换图片"}
                </button>}
              </header>
              <div className={`model-trial-stage model-trial-stage--${resultState}`}>
                <ModelTrialPreview
                  imageUrl={imageUrl}
                  boxes={boxes}
                  categories={categories}
                  loading={loading}
                  onUpload={(file) => void runPredict(file)}
                  onBrowse={!imageUrl ? chooseImage : undefined}
                  uploadDisabled={loading}
                  showSummary={false}
                />
                {!imageUrl && error && <p className="model-trial-stage__error" role="alert"><Icon name="audit" size={16} />{error}</p>}
              </div>
            </section>

            <aside className="model-trial-result-panel" aria-live="polite">
              <header className="model-trial-result-panel__header">
                <div><span>检测结果</span><h2>{!imageUrl ? "等待测试" : loading ? "正在分析图片" : error ? "检测未完成" : boxes.length ? `识别到 ${boxes.length} 个目标` : "未检测到目标"}</h2></div>
                <span className={`model-trial-state model-trial-state--${resultState}`}><i />{!imageUrl ? "待开始" : loading ? "进行中" : error ? "失败" : "已完成"}</span>
              </header>

              {!imageUrl ? (
                <div className="model-trial-ready-state">
                  <section>
                    <strong>可识别类别</strong>
                    <div className="model-trial-ready-state__categories">
                      {categories.length ? categories.map((category) => <span key={category.class_id}><i style={{ backgroundColor: category.color }} />{category.name}</span>) : <small>正在读取项目类别…</small>}
                    </div>
                  </section>
                  <p><Icon name="image" size={17} /><span><strong>图片建议</strong>主体清晰、无遮挡且占据画面主要区域。</span></p>
                </div>
              ) : loading ? (
                <div className="model-trial-loading-state"><span /><span /><span /><p>模型正在读取图片并生成目标框</p></div>
              ) : error ? (
                <div className="model-trial-error-state" role="alert">
                  <span><Icon name="audit" size={22} /></span><strong>本次检测失败</strong><p>{error}</p>
                  <button type="button" onClick={chooseImage}>选择其他图片</button>
                </div>
              ) : (
                <>
                  <div className="model-trial-metrics">
                    <div><span>目标数量</span><strong>{boxes.length}</strong><small>个检测框</small></div>
                    <div><span>最高置信度</span><strong>{boxes.length ? `${(maxConfidence * 100).toFixed(1)}%` : "—"}</strong><small>{elapsedMs === null ? "等待检测" : `本次耗时 ${elapsedMs}ms`}</small></div>
                  </div>
                  <section className="model-trial-detections">
                    <div className="model-trial-detections__title"><strong>目标明细</strong>{boxes.length > 6 && <span>前 6 项</span>}</div>
                    {visibleBoxes.length ? (
                      <ol>
                        {visibleBoxes.map((box, index) => {
                          const category = categoryFor(box.class_id);
                          return <li key={`${box.class_id}-${box.x}-${box.y}-${index}`}><i style={{ backgroundColor: category?.color || "#12A88F" }} /><span>{category?.name ?? `类别 ${box.class_id}`}</span><strong>{(box.conf * 100).toFixed(1)}%</strong></li>;
                        })}
                      </ol>
                    ) : (
                      <div className="model-trial-empty-result"><span><Icon name="search" size={21} /></span><strong>画面中未发现目标</strong><p>可更换角度更清晰、主体更完整的图片再次检测。</p></div>
                    )}
                  </section>
                </>
              )}
            </aside>
          </div>
        </section>
      )}
    </main>
  );
}
