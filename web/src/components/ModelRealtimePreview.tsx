"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { api, type ModelPreviewSnapshot, type ModelPreviewStatus } from "@/lib/api";

type Category = { class_id: number; name: string; color: string };

type Props = {
  projectId: string;
  modelId: string;
  categories: Category[];
};

const STATUS_COPY: Record<ModelPreviewStatus, { label: string; detail: string }> = {
  STARTING: { label: "正在连接", detail: "正在加载模型并连接摄像头，通常需要 5～10 秒" },
  STREAMING: { label: "实时检测中", detail: "画面与检测结果正在持续更新" },
  RECONNECTING: { label: "正在重连", detail: "视频流中断，系统正在尝试恢复" },
  STOPPING: { label: "正在停止", detail: "正在释放摄像头与推理资源" },
  STOPPED: { label: "已停止", detail: "实时预览已经结束" },
  FAILED: { label: "预览失败", detail: "连接或推理未能继续" },
};

function validRtspUrl(value: string): boolean {
  try {
    const parsed = new URL(value.trim());
    return (parsed.protocol === "rtsp:" || parsed.protocol === "rtsps:") && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

function metricValue(value: number | null, suffix = ""): string {
  return value === null ? "—" : `${value}${suffix}`;
}

export function ModelRealtimePreview({
  projectId,
  modelId,
  categories,
}: Props) {
  const [rtspUrl, setRtspUrl] = useState("");
  const [confidenceThreshold, setConfidenceThreshold] = useState(0.25);
  const [inferenceFps, setInferenceFps] = useState(5);
  const [creating, setCreating] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<ModelPreviewSnapshot | null>(null);
  const [activeTarget, setActiveTarget] = useState("");
  const [error, setError] = useState("");
  const sessionRef = useRef<string | null>(null);

  const canStart = validRtspUrl(rtspUrl)
    && Number.isFinite(confidenceThreshold)
    && confidenceThreshold >= 0.01
    && confidenceThreshold <= 1
    && Number.isFinite(inferenceFps)
    && inferenceFps >= 1
    && inferenceFps <= 10
    && !creating
    && !stopping
    && !sessionId;
  const status = snapshot?.status ?? (sessionId || creating ? "STARTING" : null);
  const statusCopy = status ? STATUS_COPY[status] : null;
  const classRows = useMemo(
    () => Object.entries(snapshot?.classCounts ?? {}).sort((a, b) => b[1] - a[1]),
    [snapshot?.classCounts],
  );

  useEffect(() => {
    if (!sessionId) return;
    let disposed = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const poll = async () => {
      try {
        const next = await api.getModelPreview(projectId, modelId, sessionId);
        if (disposed) return;
        setSnapshot(next);
        if (next.status === "FAILED") {
          setError(next.errorMessage || "实时预览未能继续，请检查视频源与模型运行环境。");
        }
        if ((next.status === "FAILED" || next.status === "STOPPED") && timer) {
          clearInterval(timer);
          timer = null;
        }
      } catch (reason) {
        if (!disposed) {
          setError(reason instanceof Error ? reason.message : "未能刷新实时预览状态。");
        }
      }
    };

    void poll();
    timer = setInterval(() => void poll(), 1000);
    return () => {
      disposed = true;
      if (timer) clearInterval(timer);
    };
  }, [modelId, projectId, sessionId]);

  useEffect(() => () => {
    const activeSessionId = sessionRef.current;
    if (activeSessionId) {
      void api.stopModelPreview(projectId, modelId, activeSessionId, { keepalive: true }).catch(() => undefined);
    }
  }, [modelId, projectId]);

  const startPreview = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canStart) return;
    const requestedUrl = rtspUrl.trim();
    setCreating(true);
    setError("");
    setSnapshot(null);
    try {
      const created = await api.createModelPreview(projectId, modelId, {
        rtspUrl: requestedUrl,
        confidenceThreshold,
        inferenceFps,
      });
      sessionRef.current = created.sessionId;
      setSessionId(created.sessionId);
      setStreamUrl(api.modelPreviewStreamUrl(created.streamPath));
      setActiveTarget("当前摄像头");
      setRtspUrl("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法创建实时预览，请重试。");
    } finally {
      setCreating(false);
    }
  };

  const stopPreview = async () => {
    const activeSessionId = sessionRef.current;
    if (!activeSessionId || stopping) return;
    setStopping(true);
    setError("");
    try {
      const stopped = await api.stopModelPreview(projectId, modelId, activeSessionId);
      setSnapshot(stopped);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "停止预览失败，请重试。");
      return;
    } finally {
      setStopping(false);
    }
    sessionRef.current = null;
    setSessionId(null);
    setStreamUrl(null);
    setActiveTarget("");
  };

  const resetTerminalSession = () => {
    sessionRef.current = null;
    setSessionId(null);
    setStreamUrl(null);
    setSnapshot(null);
    setActiveTarget("");
    setError("");
  };

  const sessionTerminal = snapshot?.status === "FAILED" || snapshot?.status === "STOPPED";

  return (
    <section className={`model-trial-workspace model-realtime-workspace model-realtime-workspace--${status?.toLowerCase() ?? "idle"}`}>
      <div className="model-realtime-toolbar">
        {!sessionId ? (
          <form className="model-realtime-form" onSubmit={startPreview}>
            <label className="model-realtime-source-field">
              <span>RTSP 视频地址</span>
              <input
                type="text"
                value={rtspUrl}
                placeholder="rtsp://用户名:密码@摄像头地址/视频路径"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                onChange={(event) => setRtspUrl(event.target.value)}
              />
              <small>地址仅用于本次会话，不会保存。</small>
            </label>
            <label>
              <span>置信度</span>
              <input
                type="number"
                min="0.01"
                max="1"
                step="0.01"
                value={confidenceThreshold}
                onChange={(event) => setConfidenceThreshold(Number(event.target.value))}
              />
            </label>
            <label>
              <span>推理帧率</span>
              <select value={inferenceFps} onChange={(event) => setInferenceFps(Number(event.target.value))}>
                {[1, 2, 3, 5, 8, 10].map((value) => <option key={value} value={value}>{value} FPS</option>)}
              </select>
            </label>
            <button type="submit" className={creating ? "is-loading" : undefined} disabled={!canStart}>
              <Icon name={creating ? "refresh" : "play"} size={16} />
              {creating ? "正在创建…" : "开始实时预览"}
            </button>
          </form>
        ) : (
          <div className="model-realtime-active-bar">
            <div className="model-realtime-active-source">
              <span className="model-realtime-source-icon" aria-hidden><Icon name="video" size={16} /></span>
              <strong>{activeTarget || "当前摄像头"}</strong>
              <small>置信度 {confidenceThreshold.toFixed(2)} · 目标 {inferenceFps} FPS</small>
            </div>
            <button type="button" onClick={stopPreview} disabled={stopping || sessionTerminal}>
              <Icon name="x" size={16} />{stopping ? "正在停止…" : "停止预览"}
            </button>
          </div>
        )}
      </div>

      <div className="model-trial-result-layout model-realtime-layout">
        <section className="model-trial-image-panel">
          <header className="model-trial-panel-header">
            <div><strong>实时画面</strong></div>
            <span className="model-trial-panel-meta">单画面</span>
          </header>
          <div className="model-trial-stage model-realtime-stage">
            {!sessionId ? (
              <div className="model-realtime-empty">
                <span><Icon name="video" size={30} /></span>
                <strong>连接真实视频，检验训练结果</strong>
                <p>填写可由 LabelKit 后端访问的 RTSP 地址，检测结果将直接绘制在实时画面中。</p>
              </div>
            ) : sessionTerminal ? (
              <div
                className={`model-realtime-empty${snapshot?.status === "FAILED" ? " model-realtime-empty--error" : ""}`}
                role={snapshot?.status === "FAILED" ? "alert" : "status"}
              >
                <span><Icon name={snapshot?.status === "FAILED" ? "audit" : "video"} size={28} /></span>
                <strong>{snapshot?.status === "FAILED" ? "实时预览未能继续" : "实时预览已停止"}</strong>
                <p>{snapshot?.status === "FAILED"
                  ? snapshot.errorMessage || error || "请检查视频地址、网络、编码格式和模型运行环境。"
                  : "本次连接已结束，可以重新配置视频源并再次预览。"}</p>
                <button type="button" onClick={resetTerminalSession}>重新配置</button>
              </div>
            ) : streamUrl ? (
              <div className="model-realtime-stream-frame">
                <img src={streamUrl} alt="RTSP 模型实时检测画面" />
                {snapshot?.status !== "STREAMING" && (
                  <div className="model-realtime-stream-overlay">
                    <span />
                    <strong>{statusCopy?.label}</strong>
                    <p>{statusCopy?.detail}</p>
                  </div>
                )}
              </div>
            ) : null}
          </div>
        </section>

        <aside className="model-trial-result-panel" aria-live="polite">
          <header className="model-trial-result-panel__header">
            <div><span>运行状态</span><h2>{statusCopy?.label || "等待开始"}</h2></div>
          </header>

          <div className="model-realtime-metrics">
            <dl>
              <div><dt>画面尺寸</dt><dd>{snapshot?.frameWidth && snapshot.frameHeight ? `${snapshot.frameWidth} × ${snapshot.frameHeight}` : "—"}</dd></div>
              <div><dt>实际推理帧率</dt><dd>{snapshot ? metricValue(snapshot.inferenceFps, " FPS") : "—"}</dd></div>
              <div><dt>最近推理耗时</dt><dd>{metricValue(snapshot?.lastInferenceMs ?? null, " ms")}</dd></div>
            </dl>
            <section className="model-realtime-count-card">
              <span>当前目标</span>
              <strong>{snapshot?.detectionCount ?? 0}</strong>
              <small>个检测框</small>
            </section>
          </div>

          <section className="model-trial-detections model-realtime-classes">
            <div className="model-trial-detections__title"><strong>实时类别</strong><span>{classRows.length ? `${classRows.length} 类` : "等待结果"}</span></div>
            {classRows.length ? (
              <ol>
                {classRows.map(([name, count]) => {
                  const category = categories.find((item) => item.name === name);
                  return <li key={name}><i style={{ backgroundColor: category?.color || "#12A88F" }} /><span>{name}</span><strong>{count}</strong></li>;
                })}
              </ol>
            ) : (
              <div className="model-realtime-no-target">
                <Icon name="search" size={20} />
                <p>{sessionId ? "当前画面暂未识别到目标" : "开始预览后显示实时检测统计"}</p>
              </div>
            )}
          </section>

          {error && snapshot?.status !== "FAILED" && <p className="model-realtime-inline-error" role="alert"><Icon name="audit" size={15} />{error}</p>}
        </aside>
      </div>
    </section>
  );
}
