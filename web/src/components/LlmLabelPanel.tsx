"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { api, Task, VlmProfile } from "@/lib/api";
import { countRelabelTarget, FIRST_LABEL_TARGET, REJECT_FIX_TARGET, RELABEL_TARGETS } from "@/lib/relabel-targets";
import { Icon } from "@/components/Icon";

function panelCopy(fixedOnlyStatus?: string) {
  if (fixedOnlyStatus === "unlabeled") {
    return {
      title: "LLM 自动标注",
      desc: "从全局设置的大模型列表中选择，对未标注图片批量理解并打框",
      action: "开始 LLM 标注",
      running: "LLM 预标注进行中…",
      nextStep: "完成后到人工复核「待确认」逐张确认",
    };
  }
  if (fixedOnlyStatus === "human_wrong") {
    return {
      title: "LLM 难例修正",
      desc: "对难例驳回图调用大模型重新理解并画框，适合权重模型搞不定的场景",
      action: "开始 LLM 修正",
      running: "LLM 修正进行中…",
      nextStep: "完成后回到「待确认」逐张确认",
    };
  }
  return {
    title: "LLM 大模型标注",
    desc: "调用视觉大模型重新理解画面并画框，结果进入「待确认」",
    action: "开始 LLM 标注",
    running: "LLM 标注进行中…",
    nextStep: "完成后到「待确认」逐张确认",
  };
}

type Props = {
  projectId: string;
  frameStats: Record<string, number>;
  onDone?: () => void;
  compact?: boolean;
  defaultOnlyStatus?: string;
  fixedOnlyStatus?: string;
  hideProgress?: boolean;
  variant?: "inline" | "dialog";
  onStarted?: () => void;
  onCancel?: () => void;
};

export function LlmLabelPanel({
  projectId,
  frameStats,
  onDone,
  compact,
  defaultOnlyStatus = "human_wrong",
  fixedOnlyStatus,
  hideProgress,
  variant = "inline",
  onStarted,
  onCancel,
}: Props) {
  const [onlyStatus, setOnlyStatus] = useState(fixedOnlyStatus ?? defaultOnlyStatus);
  const [profiles, setProfiles] = useState<VlmProfile[]>([]);
  const [profileId, setProfileId] = useState("");
  const [costPerImage, setCostPerImage] = useState(0.02);
  const [running, setRunning] = useState(false);
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [error, setError] = useState("");
  const [loadingProfiles, setLoadingProfiles] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const prevRunning = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setLoadingProfiles(true);
    setLoadError("");
    api.getSettings()
      .then((settings) => {
        if (cancelled) return;
        const enabled = (settings.vlm_profiles || []).filter((profile) => profile.enabled);
        // 兼容旧响应：没有列表时用默认投影字段兜底一条
        const fallback: VlmProfile[] =
          enabled.length > 0
            ? enabled
            : settings.vlm_model
              ? [{
                  id: settings.default_vlm_id || "default",
                  name: settings.vlm_model,
                  model: settings.vlm_model,
                  base_url: settings.vlm_base_url || "",
                  cost_per_image: settings.vlm_cost_per_image ?? 0.02,
                  enabled: true,
                }]
              : [];
        setProfiles(fallback);
        setProfileId((prev) => {
          if (prev && fallback.find((profile) => profile.id === prev)) return prev;
          return fallback.find((profile) => profile.id === settings.default_vlm_id)?.id ?? fallback[0]?.id ?? "";
        });
      })
      .catch((e) => {
        if (cancelled) return;
        setProfiles([]);
        setProfileId("");
        setLoadError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoadingProfiles(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  useEffect(() => {
    if (!projectId) return;
    api.labelEstimate(projectId, profileId || undefined).then((estimate) => {
      setCostPerImage(estimate.cost_per_image);
    });
  }, [projectId, profileId]);

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
    const t = setInterval(refreshTasks, running ? 2000 : 10000);
    return () => clearInterval(t);
  }, [projectId, running]);

  const targetCount = countRelabelTarget(fixedOnlyStatus ?? onlyStatus, frameStats);
  const estimatedCost = Math.round(targetCount * costPerImage * 100) / 100;
  const copy = panelCopy(fixedOnlyStatus);
  const selected = profiles.find((profile) => profile.id === profileId);

  const startLlmLabel = async () => {
    if (targetCount === 0) return;
    if (!profileId) {
      setError("请先在全局设置中配置可用的大模型");
      return;
    }
    setError("");
    try {
      await api.createTask(projectId, "label", {
        only_status: fixedOnlyStatus ?? onlyStatus,
        vlm_profile_id: profileId,
      });
      setRunning(true);
      refreshTasks();
      onStarted?.();
    } catch (e) {
      setError(String(e));
    }
  };

  if (loadingProfiles) {
    return (
      <div className={`flex items-center justify-center gap-2 p-6 text-sm text-[#17343A]/50 ${compact ? "p-3" : ""}`}>
        <Icon name="clock" size={14} className="animate-spin text-[#10A88F]" />
        正在加载大模型列表…
      </div>
    );
  }

  if (loadError) {
    return (
      <div className={`flex flex-col items-center justify-center p-8 border border-dashed border-red-200 rounded-xl bg-red-50/40 ${compact ? "p-4" : ""}`}>
        <div className="w-12 h-12 bg-white rounded-full flex items-center justify-center text-[#d92d20] shadow-sm mb-3">
          <Icon name="help" size={20} />
        </div>
        <h3 className="text-sm font-bold text-[#075F5A] mb-1">大模型列表加载失败</h3>
        <p className="text-xs text-[#17343A]/60 mb-4 text-center max-w-sm">{loadError}</p>
        <button
          type="button"
          className="px-4 py-2 bg-white border border-[#CFF4EC] text-[#10A88F] rounded-lg text-xs font-bold shadow-sm hover:border-[#10A88F] transition-colors"
          onClick={() => setReloadKey((key) => key + 1)}
        >
          重试
        </button>
      </div>
    );
  }

  if (profiles.length === 0) {
    return (
      <div className={`flex flex-col items-center justify-center p-8 border border-dashed border-[#CFF4EC] rounded-xl bg-[#F4FAF8]/50 ${compact ? "p-4" : ""}`}>
        <div className="w-12 h-12 bg-white rounded-full flex items-center justify-center text-[#10A88F] shadow-sm mb-3">
          <Icon name="sparkles" size={20} />
        </div>
        <h3 className="text-sm font-bold text-[#075F5A] mb-1">暂无可用大模型</h3>
        <p className="text-xs text-[#17343A]/60 mb-4 text-center">请先在全局设置中添加并启用视觉大模型。</p>
        <Link href="/settings" className="px-4 py-2 bg-white border border-[#CFF4EC] text-[#10A88F] rounded-lg text-xs font-bold shadow-sm hover:border-[#10A88F] transition-colors">
          前往全局设置
        </Link>
      </div>
    );
  }

  return (
    <div className={`flex flex-col w-full ${variant === "dialog" ? "" : compact ? "" : "card"}`}>
      {!compact && variant === "inline" && (
        <div className="mb-4">
          <h2 className="text-lg font-bold text-[#075F5A] mb-1">{copy.title}</h2>
          <p className="text-sm text-[#17343A]/60">{copy.desc}</p>
        </div>
      )}

      {error && <div className="mb-4 bg-red-50 border border-red-100 text-red-600 px-3 py-2 rounded-lg text-xs shadow-sm">{error}</div>}

      <div className={`grid gap-4 ${compact ? "" : "sm:grid-cols-2"}`}>
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-bold text-[#17343A]">选择大模型</label>
          <select
            className="w-full bg-white border border-gray-200 rounded-lg p-2.5 text-sm focus:ring-2 focus:ring-[#10A88F]/20 focus:border-[#10A88F] outline-none shadow-sm"
            value={profileId}
            onChange={(e) => setProfileId(e.target.value)}
            disabled={running}
          >
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name} ({profile.model}) · ¥{profile.cost_per_image}/张
              </option>
            ))}
          </select>
          {selected && (
            <p className="text-[10px] text-[#17343A]/50 px-1">
              {selected.base_url}
              {" · "}
              <Link href="/settings" className="text-[#10A88F] hover:underline">
                管理大模型列表
              </Link>
            </p>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-bold text-[#17343A]">待处理范围</label>
          {fixedOnlyStatus ? (
            <div className="w-full bg-[#F4FAF8] border border-[#CFF4EC] rounded-lg p-2.5 text-sm flex items-center justify-between shadow-inner">
              <span className="text-[#075F5A] font-medium">
                {(fixedOnlyStatus === "unlabeled" ? FIRST_LABEL_TARGET : REJECT_FIX_TARGET).label}
              </span>
              <span className="text-xs font-bold text-[#10A88F] bg-[#10A88F]/10 px-2 py-0.5 rounded-full">{targetCount} 张</span>
            </div>
          ) : (
            <>
              <select
                className="w-full bg-white border border-gray-200 rounded-lg p-2.5 text-sm focus:ring-2 focus:ring-[#10A88F]/20 focus:border-[#10A88F] outline-none shadow-sm"
                value={onlyStatus}
                onChange={(e) => setOnlyStatus(e.target.value)}
              >
                {RELABEL_TARGETS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <p className="mt-1 text-[10px] text-[#17343A]/50 flex justify-between">
                <span>{RELABEL_TARGETS.find((o) => o.value === onlyStatus)?.hint}</span>
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

      <div className={`${variant === "dialog" ? "mt-3" : "mt-4"} grid grid-cols-2 gap-3`}>
        <div className="bg-[#F4FAF8] border border-[#CFF4EC] rounded-xl p-3">
          <span className="text-[10px] text-[#17343A]/60 block mb-1">单张成本</span>
          <strong className="text-base font-bold text-[#075F5A]">¥{costPerImage}</strong>
        </div>
        <div className="bg-[#F4FAF8] border border-[#CFF4EC] rounded-xl p-3">
          <span className="text-[10px] text-[#17343A]/60 block mb-1">预估费用</span>
          <strong className="text-base font-bold text-[#10A88F]">¥{estimatedCost}</strong>
        </div>
      </div>

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
            disabled={running || !profileId || targetCount === 0}
            onClick={startLlmLabel}
          >
            {running ? copy.running : copy.action}
          </button>
        </div>
      ) : (
        <div className="mt-auto pt-4 flex items-center gap-4">
          <button
            className="w-40 py-2.5 bg-[#10A88F] text-white rounded-xl text-sm font-bold hover:bg-[#078D82] shadow-sm shadow-[#10A88F]/20 disabled:opacity-50 disabled:shadow-none transition-colors"
            disabled={running || !profileId || targetCount === 0}
            onClick={startLlmLabel}
          >
            {running ? copy.running : copy.action}
          </button>
          {!compact && <span className="text-xs text-[#17343A]/40">{copy.nextStep}</span>}
        </div>
      )}

      {activeTask && !hideProgress && (
        <div className="mt-4 p-3 bg-[#F4FAF8] border border-[#CFF4EC] rounded-xl shadow-inner">
          <div className="mb-2 flex justify-between text-[11px] font-bold text-[#075F5A]">
            <span className="flex items-center gap-1.5">
              <Icon name="clock" size={12} className="animate-spin text-[#10A88F]" /> 标注进度
            </span>
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

export function LlmLabelDialog({ open, onClose, fixedOnlyStatus, frameStats, ...panelProps }: DialogProps) {
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
        aria-labelledby="llm-label-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="materials-public-import-dialog__head">
          <div>
            <h2 id="llm-label-dialog-title">{copy.title}</h2>
            <p>{copy.desc} · {subtitle}</p>
          </div>
          <button type="button" className="modal-close-button" aria-label="关闭" onClick={onClose}>
            <Icon name="x" size={18} />
          </button>
        </header>
        <div className="materials-public-import-dialog__body lk-scrollbar">
          <LlmLabelPanel
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
