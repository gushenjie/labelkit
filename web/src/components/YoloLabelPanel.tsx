"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api, ModelVersion, Task } from "@/lib/api";
import { countRelabelTarget, FIRST_LABEL_TARGET, REJECT_FIX_TARGET, RELABEL_TARGETS } from "@/lib/relabel-targets";
import { Icon } from "@/components/Icon";

const TARGET_OPTIONS = RELABEL_TARGETS;

function panelCopy(fixedOnlyStatus?: string) {
  if (fixedOnlyStatus === "unlabeled") {
    return {
      title: "YOLO 自动标注",
      desc: "用已选模型对未标注图片批量打框，完成后进入人工确认",
      action: "开始 YOLO 标注",
      running: "YOLO 标注进行中…",
      nextStep: "完成后到 ③人工确认「待确认」逐张确认",
    };
  }
  if (fixedOnlyStatus === "human_wrong") {
    return {
      title: "YOLO 驳回修正",
      desc: "用模型对已驳回图片重新打框，修正后需再次人工确认",
      action: "开始 YOLO 修正",
      running: "YOLO 修正进行中…",
      nextStep: "完成后回到「待确认」逐张确认",
    };
  }
  return {
    title: "YOLO 半自动标注",
    desc: "用已选模型批量打框，结果进入「待确认」",
    action: "开始 YOLO 半自动标注",
    running: "YOLO 标注进行中…",
    nextStep: "完成后到 ③人工确认「待确认」逐张确认",
  };
}

type Props = {
  projectId: string;
  frameStats: Record<string, number>;
  onDone?: () => void;
  compact?: boolean;
  /** 锁定标注范围，隐藏下拉（如标注页固定「未标注」） */
  fixedOnlyStatus?: string;
  /** 由父级统一展示进度时隐藏面板内进度条 */
  hideProgress?: boolean;
};

export function YoloLabelPanel({ projectId, frameStats, onDone, compact, fixedOnlyStatus, hideProgress }: Props) {
  const [models, setModels] = useState<ModelVersion[]>([]);
  const [modelId, setModelId] = useState("");
  const [onlyStatus, setOnlyStatus] = useState(fixedOnlyStatus ?? "human_wrong");
  const [conf, setConf] = useState(0.25);
  const [running, setRunning] = useState(false);
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [error, setError] = useState("");
  const prevRunning = useRef(false);

  useEffect(() => {
    api.listModels(projectId).then((m) => {
      setModels(m);
      setModelId((prev) => (prev && m.find((x) => x.id === prev) ? prev : m[0]?.id ?? ""));
    });
  }, [projectId]);

  const refreshTasks = () => {
    api.listTasks(projectId).then((tasks) => {
      const relabel = tasks.find((t) => t.task_type === "relabel" && t.status === "running");
      setActiveTask(relabel ?? null);
      const relabelRunning = !!relabel;
      if (prevRunning.current && !relabelRunning) onDone?.();
      prevRunning.current = relabelRunning;
      setRunning(relabelRunning);
    });
  };

  useEffect(() => {
    refreshTasks();
    const t = setInterval(refreshTasks, running ? 2000 : 5000);
    return () => clearInterval(t);
  }, [projectId, running]);

  const targetCount = countRelabelTarget(fixedOnlyStatus ?? onlyStatus, frameStats);
  const copy = panelCopy(fixedOnlyStatus);

  const startYoloLabel = async () => {
    if (!modelId) {
      setError("请先在模型管理页上传或训练一个模型");
      return;
    }
    setError("");
    try {
      await api.createTask(projectId, "relabel", {
        model_id: modelId,
        only_status: fixedOnlyStatus ?? onlyStatus,
        conf,
      });
      setRunning(true);
      refreshTasks();
    } catch (e) {
      setError(String(e));
    }
  };

  if (models.length === 0) {
    return (
      <div className={compact ? "model-required-state model-required-state--compact" : "model-required-state"}>
        <span><Icon name="package" size={21} /></span>
        <div>
          <h3>还没有可用模型</h3>
          <p>上传已有 .pt 权重，或先用已确认数据训练一个模型。</p>
        </div>
        <Link href={`/models?project=${projectId}`} className="btn-secondary">
          前往模型库
          <Icon name="chevron-right" size={14} />
        </Link>
      </div>
    );
  }

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
          <label className="mb-1 block text-xs text-muted">选择模型</label>
          <select className="input text-sm" value={modelId} onChange={(e) => setModelId(e.target.value)}>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} (v{m.version})
              </option>
            ))}
          </select>
        </div>
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
                {TARGET_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <p className="mt-1 text-xs text-subtle">
                {TARGET_OPTIONS.find((o) => o.value === onlyStatus)?.hint} · {targetCount} 张
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
            <label className="mb-1 block text-xs text-muted">置信度阈值</label>
            <input
              className="input text-sm"
              type="number"
              min={0.05}
              max={0.95}
              step={0.05}
              value={conf}
              onChange={(e) => setConf(Number(e.target.value))}
            />
          </div>
        )}
      </div>

      <button
        className="btn-primary"
        disabled={running || !modelId || targetCount === 0}
        onClick={startYoloLabel}
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

      {compact ? (
        <Link href={`/models?project=${projectId}`} className="mt-2 block text-xs text-subtle hover:text-brand-600">
          管理模型 / 上传 .pt →
        </Link>
      ) : (
        <p className="mt-3 text-xs text-subtle">{copy.nextStep}；class 0 需对应项目第一个类别</p>
      )}
    </div>
  );
}
