"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { api, ModelCatalogItem, ModelVersion, Task } from "@/lib/api";
import { countRelabelTarget, FIRST_LABEL_TARGET, REJECT_FIX_TARGET, RELABEL_TARGETS } from "@/lib/relabel-targets";
import { Icon } from "@/components/Icon";

const TARGET_OPTIONS = RELABEL_TARGETS;

type SelectableModel = {
  id: string;
  name: string;
  versionLabel: string;
  source: string;
  projectId: string | null;
  projectName: string | null;
  task: string;
};

function panelCopy(fixedOnlyStatus?: string) {
  if (fixedOnlyStatus === "unlabeled") {
    return {
      title: "模型自动标注",
      desc: "从模型中心选择权重，对未标注图片批量打框，完成后进入人工确认",
      action: "开始自动标注",
      running: "自动标注进行中…",
      nextStep: "完成后到 ③人工确认「待确认」逐张确认",
    };
  }
  if (fixedOnlyStatus === "human_wrong") {
    return {
      title: "模型驳回修正",
      desc: "用模型中心权重对已驳回图片重新打框，修正后需再次确认",
      action: "开始模型修正",
      running: "模型修正进行中…",
      nextStep: "完成后回到「待确认」逐张确认",
    };
  }
  return {
    title: "模型半自动标注",
    desc: "从模型中心选择权重批量打框，结果进入「待确认」",
    action: "开始半自动标注",
    running: "标注进行中…",
    nextStep: "完成后到 ③人工确认「待确认」逐张确认",
  };
}

function catalogTaskMatches(taskType: "detect" | "classify" | undefined, item: ModelCatalogItem | SelectableModel) {
  if (!taskType) return true;
  const task = "task" in item ? item.task : "";
  if (taskType === "detect") return !task || task.includes("检测");
  return !task || task.includes("分类");
}

function fromCatalog(item: ModelCatalogItem): SelectableModel | null {
  if (!item.model_id) return null;
  return {
    id: item.model_id,
    name: item.name,
    versionLabel: item.version,
    source: item.source || "模型中心",
    projectId: item.project_id ?? null,
    projectName: item.project_name ?? null,
    task: item.task,
  };
}

function fromProjectModel(model: ModelVersion, projectId: string): SelectableModel {
  const origin = model.metrics?.origin === "upload" ? "上传模型" : "训练模型";
  return {
    id: model.id,
    name: model.name,
    versionLabel: `v${model.version}`,
    source: origin,
    projectId,
    projectName: null,
    task: "",
  };
}

function modelOptionLabel(model: SelectableModel, currentProjectId: string) {
  const scope =
    model.projectId === currentProjectId
      ? "本项目"
      : model.projectName
        ? model.projectName
        : model.source;
  return `${scope} · ${model.name} (${model.versionLabel})`;
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
  const [models, setModels] = useState<SelectableModel[]>([]);
  const [modelId, setModelId] = useState("");
  const [onlyStatus, setOnlyStatus] = useState(fixedOnlyStatus ?? "human_wrong");
  const [conf, setConf] = useState(0.25);
  const [running, setRunning] = useState(false);
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [error, setError] = useState("");
  const [loadingModels, setLoadingModels] = useState(true);
  const prevRunning = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setLoadingModels(true);
    Promise.all([
      api.getModelCatalog().catch(() => ({ stats: [], models: [], total: 0 })),
      api.listModels(projectId).catch(() => [] as ModelVersion[]),
      api.getProject(projectId).catch(() => null),
    ]).then(([catalog, projectModels, project]) => {
      if (cancelled) return;
      const taskType = project?.task_type;
      const byId = new Map<string, SelectableModel>();

      for (const item of catalog.models) {
        const selectable = fromCatalog(item);
        if (!selectable) continue;
        if (!catalogTaskMatches(taskType, selectable)) continue;
        byId.set(selectable.id, selectable);
      }

      for (const model of projectModels) {
        if (byId.has(model.id)) {
          const existing = byId.get(model.id)!;
          byId.set(model.id, { ...existing, projectId, projectName: existing.projectName || "本项目" });
          continue;
        }
        byId.set(model.id, fromProjectModel(model, projectId));
      }

      const merged = Array.from(byId.values()).sort((a, b) => {
        const aLocal = a.projectId === projectId ? 0 : 1;
        const bLocal = b.projectId === projectId ? 0 : 1;
        if (aLocal !== bLocal) return aLocal - bLocal;
        return a.name.localeCompare(b.name, "zh");
      });

      setModels(merged);
      setModelId((prev) => (prev && merged.find((x) => x.id === prev) ? prev : merged[0]?.id ?? ""));
      setLoadingModels(false);
    });
    return () => {
      cancelled = true;
    };
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
    const t = setInterval(refreshTasks, running ? 2000 : 10000);
    return () => clearInterval(t);
  }, [projectId, running]);

  const targetCount = countRelabelTarget(fixedOnlyStatus ?? onlyStatus, frameStats);
  const copy = panelCopy(fixedOnlyStatus);
  const selected = models.find((m) => m.id === modelId);

  const startYoloLabel = async () => {
    if (!modelId) {
      setError("请先从模型中心选择可用权重，或上传 / 训练一个模型");
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

  if (loadingModels) {
    return (
      <div className={`flex items-center justify-center gap-2 p-6 text-sm text-[#17343A]/50 ${compact ? "p-3" : ""}`}>
        <Icon name="clock" size={14} className="animate-spin text-[#10A88F]" />
        正在加载模型中心…
      </div>
    );
  }

  if (models.length === 0) {
    return (
      <div className={`flex flex-col items-center justify-center p-8 border border-dashed border-[#CFF4EC] rounded-xl bg-[#F4FAF8]/50 ${compact ? "p-4" : ""}`}>
        <div className="w-12 h-12 bg-white rounded-full flex items-center justify-center text-[#10A88F] shadow-sm mb-3">
          <Icon name="package" size={20} />
        </div>
        <h3 className="text-sm font-bold text-[#075F5A] mb-1">模型中心暂无可用权重</h3>
        <p className="text-xs text-[#17343A]/60 mb-4 text-center">
          内置示例不可用于推理。请上传已有 .pt，或先用已确认数据训练一个模型。
        </p>
        <Link href={`/models?project=${projectId}`} className="px-4 py-2 bg-white border border-[#CFF4EC] text-[#10A88F] rounded-lg text-xs font-bold shadow-sm hover:border-[#10A88F] transition-colors">
          前往模型中心
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
          <label className="text-xs font-bold text-[#17343A]">选择模型中心权重</label>
          <select
            className="w-full bg-white border border-gray-200 rounded-lg p-2.5 text-sm focus:ring-2 focus:ring-[#10A88F]/20 focus:border-[#10A88F] outline-none shadow-sm"
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {modelOptionLabel(m, projectId)}
              </option>
            ))}
          </select>
          {selected && (
            <p className="text-[10px] text-[#17343A]/50 px-1">
              {selected.source}
              {selected.projectName ? ` · ${selected.projectName}` : ""}
              {" · "}
              <Link href={`/models?project=${projectId}`} className="text-[#10A88F] hover:underline">
                打开模型中心
              </Link>
            </p>
          )}
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
