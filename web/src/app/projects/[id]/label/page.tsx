"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { YoloLabelDialog } from "@/components/YoloLabelPanel";
import { LlmLabelDialog } from "@/components/LlmLabelPanel";
import { api, Frame, Task } from "@/lib/api";
import { reviewPageUrl, reviewFilterForFrame } from "@/lib/review-nav";
import { FRAME_STATUS_SIMPLE, countPendingReview } from "@/lib/status";
import {
  matchesProjectLiveEvent,
  PROJECT_STATS_REFRESH_EVENT,
  requestProjectStatsRefresh,
} from "@/lib/project-live";
import { TaskProgress } from "@/components/ui/TaskProgress";
import { Icon } from "@/components/Icon";
import { FrameLightbox } from "@/components/FrameLightbox";
import { ProjectPageHeader } from "@/components/ProjectPageHeader";
import { WorkflowNextButton } from "@/components/WorkflowNextButton";
import { WORKFLOW_STEPS } from "@/lib/workflow";

const AUTO_TASK_TYPES = new Set(["label", "relabel"]);

type LabelMode = "llm" | "yolo";

const TASK_LABEL: Record<string, string> = {
  label: "LLM 标注",
  relabel: "模型标注",
};

const INGEST_ORIGIN_LABEL: Record<string, string> = {
  video: "视频抽帧",
  image_upload: "图片上传",
  public_dataset: "公开数据",
  dataset_import: "数据集导入",
  derived: "派生素材",
  legacy: "历史素材",
};

export default function LabelPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [mode, setMode] = useState<LabelMode>("yolo");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [frameStats, setFrameStats] = useState<Record<string, number>>({});
  const [running, setRunning] = useState(false);
  const [pendingFrames, setPendingFrames] = useState<Frame[]>([]);
  const [recentFrames, setRecentFrames] = useState<Frame[]>([]);
  const [stopping, setStopping] = useState(false);
  const [selected, setSelected] = useState<Frame | null>(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const [actionError, setActionError] = useState("");
  const [yoloDialogOpen, setYoloDialogOpen] = useState(false);
  const [llmDialogOpen, setLlmDialogOpen] = useState(false);

  const unlabeledCount = frameStats.unlabeled ?? 0;
  const pendingReviewCount = countPendingReview(frameStats);

  const goReview = (frame?: Frame) => {
    if (!id) return;
    router.push(
      reviewPageUrl(id, {
        filter: frame ? reviewFilterForFrame(frame.status) : "pending",
        frameId: frame?.id,
      })
    );
  };

  const refresh = () => {
    if (!id) return;
    api.frameStats(id).then(setFrameStats);
    api.listTasks(id).then((t) => {
      const autoTasks = t.filter((x) => AUTO_TASK_TYPES.has(x.task_type));
      setTasks(autoTasks);
      setRunning(t.some((x) => AUTO_TASK_TYPES.has(x.task_type) && x.status === "running"));
    });
    api.listFrames(id, "unlabeled", "created", 40).then(setPendingFrames);
    api.listFrames(id, undefined, "recent", 10).then((frames) => {
      const labeled = frames.filter((f) => f.status !== "unlabeled");
      setRecentFrames(labeled);
    });
  };

  useEffect(() => {
    refresh();
    if (!running) return;
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [id, running]);

  useEffect(() => {
    if (!id) return;
    const onRefresh = (event: Event) => {
      if (!matchesProjectLiveEvent(event, id)) return;
      refresh();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener(PROJECT_STATS_REFRESH_EVENT, onRefresh);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener(PROJECT_STATS_REFRESH_EVENT, onRefresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [id]);

  const activeTask = tasks.find((t) => t.status === "running");
  const processedCount =
    (frameStats.llm_labeled ?? 0) +
    (frameStats.auto_ok ?? 0) +
    (frameStats.needs_human ?? 0) +
    (frameStats.no_target ?? 0) +
    (frameStats.auto_fixed ?? 0) +
    (frameStats.human_ok ?? 0);
  const totalCount = frameStats.total ?? 0;
  const prelabelComplete = totalCount > 0 && unlabeledCount === 0 && !running;
  const labelCopy = WORKFLOW_STEPS.find((step) => step.slug === "label")!;
  const canGoReview = pendingReviewCount > 0;
  const canGoTrain = pendingReviewCount === 0 && processedCount > 0 && unlabeledCount === 0;
  const previewingPending = unlabeledCount > 0;
  const previewFrames = previewingPending ? pendingFrames : recentFrames;
  const manualLabelAction = running ? (
    <span className="px-5 py-3 bg-[#F4FAF8] border border-[#D0D5DD] text-[#98A2B3] rounded-xl text-sm font-bold cursor-not-allowed" aria-disabled="true" title="自动标注任务进行中，完成或停止后才能人工标注">
      直接人工标注
    </span>
  ) : (
    <Link href={`/projects/${id}/review?filter=manual`} className="px-5 py-3 bg-white border border-[#CFF4EC] text-[#087866] rounded-xl text-sm font-bold hover:border-[#10A88F] hover:bg-[#F4FAF8] shadow-sm transition-colors">
      直接人工标注
    </Link>
  );

  useEffect(() => {
    setSelected((previous) => {
      if (previous && previewFrames.some((frame) => frame.id === previous.id)) return previous;
      return previewFrames[0] ?? null;
    });
    setLightboxIndex((previous) => Math.min(previous, Math.max(0, previewFrames.length - 1)));
  }, [previewFrames]);

  const stopLabel = async () => {
    if (!id) return;
    setStopping(true);
    try {
      if (activeTask) {
        await api.cancelTask(id, activeTask.id);
      } else {
        await api.cancelRunningTask(id);
      }
      refresh();
    } catch (e) {
      setActionError(String(e));
    } finally {
      setStopping(false);
    }
  };

  return (
    <div className="label-page min-h-[calc(100vh-64px)] bg-[#f4faf8] text-[#17343A] font-sans flex flex-col relative overflow-hidden p-8">
      <div className="absolute top-[-20%] left-[-10%] w-[600px] h-[600px] bg-[#10A88F]/10 blur-[120px] rounded-full pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[500px] h-[500px] bg-[#078D82]/10 blur-[100px] rounded-full pointer-events-none" />

      <div className="relative z-10 flex flex-col h-full w-full">
        <ProjectPageHeader
          title="素材标注"
          eyebrow="Labeling workflow"
          description={labelCopy.pageDescription}
          action={
            canGoReview ? (
              <WorkflowNextButton href={`/projects/${id}/review`} label="标注复核" />
            ) : canGoTrain ? (
              <WorkflowNextButton href={`/projects/${id}/train`} label="训练或导出" />
            ) : (
              <WorkflowNextButton
                label="标注复核"
                disabled
                disabledHint={unlabeledCount > 0 ? "继续完成标注" : "等待标注结果"}
              />
            )
          }
        />

        {/* Metrics Row */}
        <div className="flex flex-wrap lg:flex-nowrap gap-4 mb-6 shrink-0 h-auto lg:h-[100px]">
          <div className="flex-1 min-w-[200px] bg-white/80 backdrop-blur-xl border border-white shadow-[0_8px_32px_rgba(16,168,143,0.06)] rounded-2xl p-4 flex items-center gap-4">
            <div className="w-10 h-10 rounded-xl bg-[#F4FAF8] text-[#10A88F] flex items-center justify-center border border-white shadow-sm"><Icon name="image" size={20} /></div>
            <div>
              <strong className="text-2xl font-bold text-[#075F5A] leading-none block">{totalCount}</strong>
              <span className="text-xs text-[#17343A]/60">项目素材</span>
            </div>
          </div>
          <div className="flex-1 min-w-[200px] bg-white/80 backdrop-blur-xl border border-white shadow-[0_8px_32px_rgba(16,168,143,0.06)] rounded-2xl p-4 flex items-center gap-4">
            <div className="w-10 h-10 rounded-xl bg-[#F4FAF8] text-[#10A88F] flex items-center justify-center border border-white shadow-sm"><Icon name="sparkles" size={20} /></div>
            <div>
              <strong className="text-2xl font-bold text-[#075F5A] leading-none block">{unlabeledCount}</strong>
              <span className="text-xs text-[#17343A]/60">待预标注</span>
            </div>
          </div>
          <div className="flex-1 min-w-[200px] bg-white/80 backdrop-blur-xl border border-white shadow-[0_8px_32px_rgba(16,168,143,0.06)] rounded-2xl p-4 flex items-center gap-4">
            <div className="w-10 h-10 rounded-xl bg-[#F4FAF8] text-[#10A88F] flex items-center justify-center border border-white shadow-sm"><Icon name="check" size={20} /></div>
            <div>
              <strong className="text-2xl font-bold text-[#075F5A] leading-none block">{processedCount}</strong>
              <span className="text-xs text-[#17343A]/60">已有标注</span>
            </div>
          </div>
          {totalCount > 0 && !prelabelComplete && (
          <div className="flex-[2] bg-white/80 backdrop-blur-xl border border-white shadow-[0_8px_32px_rgba(16,168,143,0.06)] rounded-2xl p-4 flex items-center justify-between min-w-[280px]">
            <span className="text-sm font-bold text-[#17343A]/70">标注引擎</span>
            <div className="flex bg-gray-100/50 p-1 rounded-xl border border-white shadow-inner">
              <button
                className={`px-6 py-2 rounded-lg text-sm font-bold transition-all ${mode === "yolo" ? 'bg-white text-[#075F5A] shadow-sm ring-1 ring-[#10A88F]/20' : 'text-[#17343A]/50 hover:text-[#075F5A]'}`}
                onClick={() => setMode("yolo")}
                disabled={running}
              >
                模型中心
              </button>
              <button
                className={`px-6 py-2 rounded-lg text-sm font-bold transition-all ${mode === "llm" ? 'bg-white text-[#075F5A] shadow-sm ring-1 ring-[#10A88F]/20' : 'text-[#17343A]/50 hover:text-[#075F5A]'}`}
                onClick={() => setMode("llm")}
                disabled={running}
              >
                LLM 大模型
              </button>
            </div>
          </div>
          )}
        </div>

        {actionError && <div className="mb-4 bg-red-50 border border-red-100 text-red-600 px-4 py-3 rounded-xl text-sm shadow-sm">{actionError}</div>}

        {activeTask && (
          <div className="mb-6 bg-white/80 backdrop-blur-xl border border-white shadow-[0_8px_32px_rgba(16,168,143,0.06)] rounded-2xl p-5">
            <TaskProgress label={TASK_LABEL[activeTask.task_type] ?? "标注进度"} progress={activeTask.progress} total={activeTask.total} onStop={stopLabel} stopping={stopping} />
          </div>
        )}

        <div className="flex-1 flex flex-col gap-6 overflow-hidden min-h-0">
          {totalCount === 0 ? (
            <div className="flex-1 bg-white/80 backdrop-blur-xl border border-white shadow-[0_8px_32px_rgba(16,168,143,0.06)] rounded-2xl p-10 flex flex-col items-center justify-center text-center shrink-0">
              <div className="w-20 h-20 bg-[#F4FAF8] text-[#10A88F] rounded-full flex items-center justify-center mb-6 shadow-sm border border-white"><Icon name="image" size={32} /></div>
              <span className="text-[10px] font-bold tracking-wider text-[#10A88F] uppercase mb-2">Material required</span>
              <h2 className="text-xl font-bold text-[#075F5A] mb-2">还没有可预标注的素材</h2>
              <p className="text-sm text-[#17343A]/60 mb-8 max-w-md">先前往素材准备上传图片，或从视频中提取可标注帧后，再进行 AI 或人工标注。</p>
              <Link href={`/projects/${id}/materials`} className="bg-[#10A88F] text-white px-6 py-3 rounded-xl text-sm font-bold flex items-center gap-2 hover:bg-[#078D82] shadow-sm shadow-[#10A88F]/20 transition-colors">
                前往素材准备 <Icon name="chevron-right" size={16} />
              </Link>
            </div>
          ) : prelabelComplete ? (
            <div className="flex-1 bg-white/80 backdrop-blur-xl border border-white shadow-[0_8px_32px_rgba(16,168,143,0.06)] rounded-2xl p-10 flex flex-col items-center justify-center text-center shrink-0">
              <div className="w-20 h-20 bg-[#F4FAF8] text-[#10A88F] rounded-full flex items-center justify-center mb-6 shadow-sm border border-white"><Icon name="check" size={32} /></div>
              <span className="text-[10px] font-bold tracking-wider text-[#10A88F] uppercase mb-2">Pre-label complete</span>
              <h2 className="text-xl font-bold text-[#075F5A] mb-2">预标注已完成</h2>
              <p className="text-sm text-[#17343A]/60 mb-8 max-w-md">
                {pendingReviewCount > 0
                  ? `${processedCount} 张素材已有初始标注，其中 ${pendingReviewCount} 张等待人工核对，请前往复核。`
                  : `${processedCount} 张素材已有标注结果，当前结果已通过审查，可以继续训练或导出。`}
              </p>
              {pendingReviewCount > 0 ? (
                <button type="button" className="bg-[#10A88F] text-white px-8 py-3.5 rounded-xl text-sm font-bold flex items-center gap-2 hover:bg-[#078D82] shadow-sm shadow-[#10A88F]/20 transition-colors" onClick={() => goReview()}>
                  复核 {pendingReviewCount} 张结果 <Icon name="chevron-right" size={16} />
                </button>
              ) : (
                <Link href={`/projects/${id}/train`} className="bg-[#10A88F] text-white px-8 py-3.5 rounded-xl text-sm font-bold flex items-center gap-2 hover:bg-[#078D82] shadow-sm shadow-[#10A88F]/20 transition-colors">
                  训练或导出 <Icon name="chevron-right" size={16} />
                </Link>
              )}
            </div>
          ) : mode === "llm" ? (
            <div className="shrink-0 bg-white/80 backdrop-blur-xl border border-white shadow-[0_8px_32px_rgba(16,168,143,0.06)] rounded-2xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="flex items-center gap-4 min-w-0">
                <div className="w-12 h-12 bg-[#F4FAF8] text-[#10A88F] rounded-xl flex items-center justify-center shrink-0 border border-white shadow-sm">
                  <Icon name="sparkles" size={22} />
                </div>
                <div className="min-w-0">
                  <h2 className="text-lg font-bold text-[#075F5A] mb-1">LLM 大模型预标注</h2>
                  <p className="text-sm text-[#17343A]/60">
                    {unlabeledCount > 0
                      ? `${unlabeledCount} 张未标注 · 从全局设置的大模型列表中选择后批量理解并打框`
                      : "当前没有待预标注素材"}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                {manualLabelAction}
                <button
                  type="button"
                  className="px-6 py-3 bg-[#10A88F] text-white rounded-xl text-sm font-bold hover:bg-[#078D82] shadow-sm shadow-[#10A88F]/20 disabled:opacity-50 disabled:shadow-none transition-colors"
                  disabled={running || unlabeledCount === 0}
                  onClick={() => setLlmDialogOpen(true)}
                >
                  {running && activeTask?.task_type === "label" ? "LLM 标注进行中…" : "选择模型并标注"}
                </button>
              </div>
            </div>
          ) : (
            <div className="shrink-0 bg-white/80 backdrop-blur-xl border border-white shadow-[0_8px_32px_rgba(16,168,143,0.06)] rounded-2xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="flex items-center gap-4 min-w-0">
                <div className="w-12 h-12 bg-[#F4FAF8] text-[#10A88F] rounded-xl flex items-center justify-center shrink-0 border border-white shadow-sm">
                  <Icon name="package" size={22} />
                </div>
                <div className="min-w-0">
                  <h2 className="text-lg font-bold text-[#075F5A] mb-1">模型中心自动标注</h2>
                  <p className="text-sm text-[#17343A]/60">
                    {unlabeledCount > 0
                      ? `${unlabeledCount} 张未标注 · 从模型中心选择权重（含上传的 .pt / 训练产物）批量打框`
                      : "当前没有待预标注素材"}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                {manualLabelAction}
                <button
                  type="button"
                  className="px-6 py-3 bg-[#10A88F] text-white rounded-xl text-sm font-bold hover:bg-[#078D82] shadow-sm shadow-[#10A88F]/20 disabled:opacity-50 disabled:shadow-none transition-colors"
                  disabled={running || unlabeledCount === 0}
                  onClick={() => setYoloDialogOpen(true)}
                >
                  {running && activeTask?.task_type === "relabel" ? "自动标注进行中…" : "选择模型并标注"}
                </button>
              </div>
            </div>
          )}

          {previewFrames.length > 0 && (
            <div className="flex-none bg-white/80 backdrop-blur-xl border border-white shadow-[0_8px_32px_rgba(16,168,143,0.06)] rounded-2xl p-6 flex flex-col shrink-0 mt-auto">
              <div className="flex justify-between items-end mb-4 shrink-0">
                <div>
                  <h3 className="text-base font-bold text-[#075F5A] flex items-center gap-2">
                    <Icon name="image" size={16} className="text-[#10A88F]" />
                    {previewingPending ? `本次待标注素材（${unlabeledCount} 张）` : "最近标注结果"}
                  </h3>
                </div>
                <div className="flex items-center gap-4">
                  {!previewingPending && pendingReviewCount > 0 && (
                    <span className="text-xs font-medium text-[#d92d20] bg-red-50 border border-red-100 px-2 py-1 rounded-md">
                      有 {pendingReviewCount} 张待复核
                    </span>
                  )}
                  <span className="text-xs text-[#17343A]/50">
                    {previewingPending
                      ? `显示 ${pendingFrames.length} / ${unlabeledCount} 张 · 只会处理以下未标注素材 · 单击查看`
                      : `最近 ${recentFrames.length} 张 · 单击大图 · 双击复核`}
                  </span>
                </div>
              </div>

              <div className="overflow-x-auto border border-[#f0f4f3] bg-[#F4FAF8]/30 rounded-xl p-4 custom-scrollbar">
                <div className="flex gap-4 items-stretch min-w-min">
                  {previewFrames.map((f, frameIndex) => (
                    <div
                      key={f.id}
                      className={`relative w-36 h-36 sm:w-40 sm:h-40 shrink-0 rounded-xl overflow-hidden cursor-pointer transition-all border-2 ${selected?.id === f.id ? "border-[#10A88F] shadow-md ring-2 ring-[#10A88F]/20 scale-[1.02] z-10" : "border-transparent hover:border-[#CFF4EC] shadow-sm"}`}
                      onClick={() => { setSelected(f); setLightboxIndex(frameIndex); setLightboxOpen(true); }}
                      onDoubleClick={() => previewingPending ? router.push(`/projects/${id}/review?filter=manual&frame=${f.id}`) : goReview(f)}
                      title={`${f.filename}（单击查看大图，双击${previewingPending ? "人工标注" : "复核"}）`}
                    >
                      <img src={api.frameImageUrl(id!, f.id, true, { maxEdge: 320 })} alt={f.filename} className="w-full h-full object-cover" />
                      <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/70 to-transparent p-2 pt-6 flex items-center justify-between gap-2">
                        {previewingPending && (
                          <span className="truncate text-[10px] font-medium text-white/90">
                            {INGEST_ORIGIN_LABEL[f.ingest_origin ?? "legacy"] ?? "项目素材"}
                          </span>
                        )}
                        <span className="shrink-0 text-[10px] font-bold text-white bg-black/40 backdrop-blur-md px-2 py-0.5 rounded shadow-sm">{FRAME_STATUS_SIMPLE[f.status]}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <YoloLabelDialog
        open={yoloDialogOpen}
        onClose={() => setYoloDialogOpen(false)}
        projectId={id!}
        frameStats={frameStats}
        fixedOnlyStatus="unlabeled"
        onDone={() => {
          refresh();
          if (id) requestProjectStatsRefresh(id);
        }}
      />

      <LlmLabelDialog
        open={llmDialogOpen}
        onClose={() => setLlmDialogOpen(false)}
        projectId={id!}
        frameStats={frameStats}
        fixedOnlyStatus="unlabeled"
        onDone={() => {
          refresh();
          if (id) requestProjectStatsRefresh(id);
        }}
      />

      <FrameLightbox
        open={lightboxOpen}
        frames={previewFrames}
        index={lightboxIndex}
        projectId={id!}
        onClose={() => setLightboxOpen(false)}
        onIndexChange={(nextIndex) => {
          setLightboxIndex(nextIndex);
          const frame = previewFrames[nextIndex];
          if (frame) setSelected(frame);
        }}
        reviewLabel={previewingPending ? "人工标注此图" : undefined}
        onReview={(frame) => {
          setLightboxOpen(false);
          if (previewingPending) router.push(`/projects/${id}/review?filter=manual&frame=${frame.id}`);
          else goReview(frame);
        }}
      />
    </div>
  );
}
