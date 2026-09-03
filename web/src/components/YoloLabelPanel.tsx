"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
      running: "YOLO 预标注进行中…",
      nextStep: "完成后到 ③人工确认「待确认」逐张确认",
    };
  }
  if (fixedOnlyStatus === "human_wrong") {
    return {
      title: "YOLO 驳回修正",
      desc: "用模型对已驳回图片重新打框，修正后需再次确认",
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
  fixedOnlyStatus?: string;
  hideProgress?: boolean;
  variant?: "inline" | "dialog";
  onStarted?: () => void;
  onCancel?: () => void;
};

export function YoloLabelPanel({
  projectId,
  frameStats,
  onDone,
  compact,
  fixedOnlyStatus,
  hideProgress,
  variant = "inline",
  onStarted,
  onCancel,
}: Props) {
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
      onStarted?.();
    } catch (e) {
      setError(String(e));
    }
  };

  if (models.length === 0) {
    return (
      <div className={`flex flex-col items-center justify-center p-8 border border-dashed border-[#CFF4EC] rounded-xl bg-[#F4FAF8]/50 ${compact ? 'p-4' : ''}`}>
        <div className="w-12 h-12 bg-white rounded-full flex items-center justify-center text-[#10A88F] shadow-sm mb-3">
          <Icon name="package" size={20} />
        </div>
        <h3 className="text-sm font-bold text-[#075F5A] mb-1">还没有可用模型</h3>
        <p className="text-xs text-[#17343A]/60 mb-4 text-center">上传已有 .pt 权重，或先用已确认数据训练一个模型。</p>
        <Link href={`/models?project=${projectId}`} className="px-4 py-2 bg-white border border-[#CFF4EC] text-[#10A88F] rounded-lg text-xs font-bold shadow-sm hover:border-[#10A88F] transition-colors">
          前往模型库
        </Link>
      </div>
    );
  }

  return (
    <div className={`flex flex-col w-full ${variant === "dialog" ? "" : "h-full"}`}>
      {!compact && variant === "inline" && (
        <div className="mb-4">
          <h2 className="text-lg font-bold text-[#075F5A] mb-1">{copy.title}</h2>
          <p className="text-sm text-[#17343A]/60">{copy.desc}</p>
        </div>
      )}

      {error && <div className="mb-4 bg-red-50 border border-red-100 text-red-600 px-3 py-2 rounded-lg text-xs shadow-sm">{error}</div>}

      <div className={`grid gap-4 ${compact ? "" : "sm:grid-cols-2"}`}>
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-bold text-[#17343A]">选择模型</label>
          <select
            className="w-full bg-white border border-gray-200 rounded-lg p-2.5 text-sm focus:ring-2 focus:ring-[#10A88F]/20 focus:border-[#10A88F] outline-none shadow-sm"
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} (v{m.version})
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-bold text-[#17343A]">待处理范围</label>
          {fixedOnlyStatus ? (
            <div className="w-full bg-[#F4FAF8] border border-[#CFF4EC] rounded-lg p-2.5 text-sm flex items-center justify-between shadow-inner">
              <span className="text-[#075F5A] font-medium">{(fixedOnlyStatus === "unlabeled" ? FIRST_LABEL_TARGET : REJECT_FIX_TARGET).label}</span>
              <span className="text-xs font-bold text-[#10A88F] bg-[#10A88F]/10 px-2 py-0.5 rounded-full">{targetCount} 张</span>
            </div>
          ) : (
            <>
              <select
                className="w-full bg-white border border-gray-200 rounded-lg p-2.5 text-sm focus:ring-2 focus:ring-[#10A88F]/20 focus:border-[#10A88F] outline-none shadow-sm"
                value={onlyStatus}
                onChange={(e) => setOnlyStatus(e.target.value)}
              >
                {TARGET_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <p className="mt-1 text-[10px] text-[#17343A]/50 flex justify-between">
                <span>{TARGET_OPTIONS.find((o) => o.value === onlyStatus)?.hint}</span>
                <span className="font-bold text-[#10A88F]">{targetCount} 张</span>
              </p>
            </>
          )}
          {fixedOnlyStatus && (
            <p className="text-[10px] text-[#17343A]/50 px-1">
              {(fixedOnlyStatus === "unlabeled" ? FIRST_LABEL_TARGET : REJECT_FIX_TARGET).hint}
            </p>
          )}
        </div>
      </div>

      {!compact && (
        <details className={`${variant === "dialog" ? "mt-2 mb-0" : "mt-4 mb-5"} border-t border-[#CFF4EC] pt-3`}>
          <summary className="w-fit cursor-pointer text-xs font-bold text-[#075F5A]">高级设置</summary>
          <div className="mt-3 max-w-[360px]">
            <label className="text-xs font-bold text-[#17343A] block mb-1.5">置信度阈值 (Confidence)</label>
            <input
              className="w-full max-w-[240px] bg-white border border-gray-200 rounded-lg p-2.5 text-sm focus:ring-2 focus:ring-[#10A88F]/20 focus:border-[#10A88F] outline-none shadow-sm"
              type="number"
              min={0.05}
              max={0.95}
              step={0.05}
              value={conf}
              onChange={(e) => setConf(Number(e.target.value))}
            />
            <p className="mt-1.5 text-[10px] leading-relaxed text-[#17343A]/50">低于该阈值的检测结果不会生成标注框，默认值适合首次预标注。</p>
          </div>
        </details>
      )}

      {variant === "dialog" ? (
        <div className="mt-5 flex items-center justify-end gap-3 border-t border-[#edf2f1] pt-4">
          <button
            type="button"
            className="px-4 py-2.5 rounded-xl text-sm font-bold text-[#17343A]/70 hover:bg-[#F4FAF8] transition-colors"
            disabled={running}
            onClick={onCancel}
          >
            取消
          </button>
          <button
            type="button"
            className="min-w-[140px] px-5 py-2.5 bg-[#10A88F] text-white rounded-xl text-sm font-bold hover:bg-[#078D82] shadow-sm shadow-[#10A88F]/20 disabled:opacity-50 disabled:shadow-none transition-colors"
            disabled={running || !modelId || targetCount === 0}
            onClick={startYoloLabel}
          >
            {running ? copy.running : copy.action}
          </button>
        </div>
      ) : (
        <div className="mt-auto pt-2 flex items-center gap-4">
          <button
            className="w-40 py-2.5 bg-[#10A88F] text-white rounded-xl text-sm font-bold hover:bg-[#078D82] shadow-sm shadow-[#10A88F]/20 disabled:opacity-50 disabled:shadow-none transition-colors"
            disabled={running || !modelId || targetCount === 0}
            onClick={startYoloLabel}
          >
            {running ? copy.running : copy.action}
          </button>
          <span className="text-xs text-[#17343A]/40">{copy.nextStep}；class 0 需对应项目第一个类别</span>
        </div>
      )}

      {activeTask && !hideProgress && (
        <div className="mt-4 p-3 bg-[#F4FAF8] border border-[#CFF4EC] rounded-xl shadow-inner">
          <div className="mb-2 flex justify-between text-[11px] font-bold text-[#075F5A]">
            <span className="flex items-center gap-1.5"><Icon name="clock" size={12} className="animate-spin text-[#10A88F]" /> 标注进度</span>
            <span>{activeTask.progress} / {activeTask.total}</span>
          </div>
          <div className="h-1.5 rounded-full bg-white border border-[#CFF4EC]/50 overflow-hidden">
            <div
              className="h-full rounded-full bg-[#10A88F] transition-all duration-300"
              style={{ width: activeTask.total ? `${(activeTask.progress / activeTask.total) * 100}%` : "0%" }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

type DialogProps = Omit<Props, "variant" | "onCancel"> & {
  open: boolean;
  onClose: () => void;
};

export function YoloLabelDialog({ open, onClose, fixedOnlyStatus, frameStats, ...panelProps }: DialogProps) {
  const copy = panelCopy(fixedOnlyStatus);
  const scopeStatus = fixedOnlyStatus ?? "human_wrong";
  const targetCount = countRelabelTarget(scopeStatus, frameStats);
  const scopeLabel = scopeStatus === "unlabeled" ? FIRST_LABEL_TARGET.label : REJECT_FIX_TARGET.label;

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;

  const subtitle =
    fixedOnlyStatus === "unlabeled"
      ? `${targetCount} 张未标注 · 完成后进入人工复核`
      : `${scopeLabel} ${targetCount} 张 · 修正后需再次确认`;

  return createPortal(
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="materials-public-import-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="yolo-label-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="materials-public-import-dialog__head">
          <div>
            <h2 id="yolo-label-dialog-title">{copy.title}</h2>
            <p>{copy.desc} · {subtitle}</p>
          </div>
          <button type="button" className="modal-close-button" aria-label="关闭" onClick={onClose}>
            <Icon name="x" size={18} />
          </button>
        </header>
        <div className="materials-public-import-dialog__body lk-scrollbar">
          <YoloLabelPanel
            {...panelProps}
            frameStats={frameStats}
            fixedOnlyStatus={fixedOnlyStatus}
            variant="dialog"
            hideProgress
            onCancel={onClose}
            onStarted={onClose}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}
