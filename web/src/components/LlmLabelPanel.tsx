"use client";

import { useEffect, useRef, useState } from "react";
import { api, Task } from "@/lib/api";
import { countRelabelTarget, FIRST_LABEL_TARGET, REJECT_FIX_TARGET, RELABEL_TARGETS } from "@/lib/relabel-targets";

function panelCopy(fixedOnlyStatus?: string) {
  if (fixedOnlyStatus === "human_wrong") {
    return {
      title: "LLM 难例修正",
      desc: "对难例驳回图调用大模型重新理解并画框，适合 PT 模型搞不定的场景",
      action: "开始 LLM 修正",
      running: "LLM 修正进行中…",
    };
  }
  return {
    title: "LLM 大模型标注",
    desc: "调用视觉大模型重新理解画面并画框，结果进入「待确认」",
    action: "开始 LLM 标注",
    running: "LLM 标注进行中…",
  };
}

type Props = {
  projectId: string;
  frameStats: Record<string, number>;
  onDone?: () => void;
  compact?: boolean;
  /** 锁定标注范围（如默认「已驳回」） */
  defaultOnlyStatus?: string;
  fixedOnlyStatus?: string;
  hideProgress?: boolean;
};

export function LlmLabelPanel({
  projectId,
  frameStats,
  onDone,
  compact,
  defaultOnlyStatus = "human_wrong",
  fixedOnlyStatus,
  hideProgress,
}: Props) {
  const [onlyStatus, setOnlyStatus] = useState(fixedOnlyStatus ?? defaultOnlyStatus);
  const [costPerImage, setCostPerImage] = useState(0.02);
  const [running, setRunning] = useState(false);
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [error, setError] = useState("");
  const prevRunning = useRef(false);

  useEffect(() => {
    api.labelEstimate(projectId).then((e) => setCostPerImage(e.cost_per_image));
  }, [projectId]);

  const refreshTasks = () => {
    api.listTasks(projectId).then((tasks) => {
      const label = tasks.find((t) => t.task_type === "label" && t.status === "running");
      setActiveTask(label ?? null);
      const labelRunning = !!label;
      if (prevRunning.current && !labelRunning) onDone?.();
      prevRunning.current = labelRunning;
      setRunning(labelRunning);
    });
  };

  useEffect(() => {
    refreshTasks();
    const t = setInterval(refreshTasks, running ? 2000 : 5000);
    return () => clearInterval(t);
  }, [projectId, running]);

  const targetCount = countRelabelTarget(fixedOnlyStatus ?? onlyStatus, frameStats);
  const estimatedCost = Math.round(targetCount * costPerImage * 100) / 100;
  const copy = panelCopy(fixedOnlyStatus);

  const startLlmLabel = async () => {
    if (targetCount === 0) return;
    setError("");
    try {
      await api.createTask(projectId, "label", {
        only_status: fixedOnlyStatus ?? onlyStatus,
      });
      setRunning(true);
      refreshTasks();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className={compact ? "" : "card"}>
      {!compact && (
        <>
          <h2 className="mb-2 font-semibold">{copy.title}</h2>
          <p className="mb-3 text-sm text-muted">{copy.desc}</p>
        </>
      )}

      {error && <p className="mb-3 text-sm text-danger-600">{error}</p>}

      <div className={`grid gap-3 ${compact ? "" : "mb-3 sm:grid-cols-2"}`}>
        <div>
          <label className="mb-1 block text-xs text-muted">标注范围</label>
          {fixedOnlyStatus ? (
            <p className="input text-sm text-text">
              {(fixedOnlyStatus === "unlabeled" ? FIRST_LABEL_TARGET : REJECT_FIX_TARGET).label}
              <span className="ml-2 text-subtle">· {targetCount} 张</span>
            </p>
          ) : (
            <>
              <select className="input text-sm" value={onlyStatus} onChange={(e) => setOnlyStatus(e.target.value)}>
                {RELABEL_TARGETS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <p className="mt-1 text-xs text-subtle">
                {RELABEL_TARGETS.find((o) => o.value === onlyStatus)?.hint} · {targetCount} 张
              </p>
            </>
          )}
          {fixedOnlyStatus && (
            <p className="mt-1 text-xs text-subtle">
              {(fixedOnlyStatus === "unlabeled" ? FIRST_LABEL_TARGET : REJECT_FIX_TARGET).hint}
            </p>
          )}
        </div>
        {!compact && (
          <div>
            <label className="mb-1 block text-xs text-muted">费用预估</label>
            <p className="input text-sm text-text">
              ¥{costPerImage}/张 · 约 ¥{estimatedCost}
            </p>
          </div>
        )}
      </div>

      {compact && targetCount > 0 && (
        <p className="mb-2 text-xs text-subtle">约 ¥{costPerImage}/张 · 预估 ¥{estimatedCost}</p>
      )}

      <button
        className="btn-primary"
        disabled={running || targetCount === 0}
        onClick={startLlmLabel}
      >
        {running ? copy.running : copy.action}
      </button>

      {activeTask && !hideProgress && (
        <div className="mt-3">
          <div className="mb-1 flex justify-between text-xs text-muted">
            <span>进度</span>
            <span>{activeTask.progress}/{activeTask.total}</span>
          </div>
          <div className="h-1.5 rounded bg-surface-soft">
            <div
              className="h-1.5 rounded bg-brand-600 transition-all"
              style={{ width: activeTask.total ? `${(activeTask.progress / activeTask.total) * 100}%` : "0%" }}
            />
          </div>
        </div>
      )}

      {!compact && (
        <p className="mt-3 text-xs text-subtle">
          适合 PT 模型漏检/误检的难例；完成后到「待确认」逐张确认
        </p>
      )}
    </div>
  );
}
