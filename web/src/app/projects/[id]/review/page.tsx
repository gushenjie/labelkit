"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, Annotation, Frame, Project, PublicDatasetImport, Task } from "@/lib/api";
import { AnnotationEditor } from "@/components/AnnotationEditor";
import { LlmLabelPanel } from "@/components/LlmLabelPanel";
import { YoloLabelPanel } from "@/components/YoloLabelPanel";
import { Icon } from "@/components/Icon";
import { ProjectPageHeader } from "@/components/ProjectPageHeader";
import { WorkflowNextButton } from "@/components/WorkflowNextButton";
import { WORKFLOW_STEPS } from "@/lib/workflow";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { TaskProgress } from "@/components/ui/TaskProgress";
import { EmptyState } from "@/components/ui/EmptyState";
import { LoadingScreen } from "@/components/ui/LoadingScreen";
import { useToast } from "@/components/ui/ToastProvider";
import {
  countBlockingReview,
  countConfirmed,
  countPendingReview,
  countRejected,
  countSampleReview,
  countTrainable,
  FRAME_STATUS_SIMPLE,
  normalizeReviewFilter,
  reviewStatuses,
  REVIEW_FILTERS,
  ReviewFilter,
} from "@/lib/status";

export default function ReviewPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const frameParam = searchParams.get("frame");
  const filterParam = searchParams.get("filter") ?? searchParams.get("status");
  const { toast } = useToast();

  const [project, setProject] = useState<Project | null>(null);
  const [frames, setFrames] = useState<Frame[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [pageTotal, setPageTotal] = useState(0);
  const [loadingNext, setLoadingNext] = useState(false);
  const [frameStats, setFrameStats] = useState<Record<string, number>>({});
  const [tasks, setTasks] = useState<Task[]>([]);
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [actionError, setActionError] = useState("");
  const [reviewDoneBanner, setReviewDoneBanner] = useState<number | null>(null);
  const prevReviewRunning = useRef(false);
  const draftsRef = useRef<Map<string, Annotation[]>>(new Map());
  const sessionStart = useRef(Date.now());
  const [confirmedInSession, setConfirmedInSession] = useState(0);

  const [filter, setFilter] = useState<ReviewFilter | null>(null);
  const [idx, setIdx] = useState(0);
  const [isEditing, setIsEditing] = useState(false);
  const [showAutoReview, setShowAutoReview] = useState(false);
  const [showRelabel, setShowRelabel] = useState(false);
  const [relabelMode, setRelabelMode] = useState<"yolo" | "llm">("yolo");
  const filmstripRef = useRef<HTMLDivElement>(null);
  const activeThumbRef = useRef<HTMLDivElement>(null);
  const [annotationSidePanel, setAnnotationSidePanel] = useState<HTMLDivElement | null>(null);
  const [annotationActionPanel, setAnnotationActionPanel] = useState<HTMLDivElement | null>(null);
  const [publicImports, setPublicImports] = useState<PublicDatasetImport[]>([]);
  const [approvingTrain, setApprovingTrain] = useState(false);

  const pendingReviewImports = publicImports.filter((item) =>
    ["review", "review_expanded", "full_review_required"].includes(item.state),
  );
  const hasPublicReviewGate = pendingReviewImports.length > 0;

  const reviewable =
    (frameStats.llm_labeled ?? 0) + (frameStats.needs_human ?? 0) + (frameStats.auto_fixed ?? 0);
  const activeTask = tasks.find((t) => t.status === "running");
  const pendingCount = countPendingReview(frameStats);
  const rejectedCount = countRejected(frameStats);
  const confirmedCount = countConfirmed(frameStats);

  useEffect(() => {
    if (!id) return;
    api.getProject(id).then(setProject);
  }, [id]);

  useEffect(() => {
    if (!id) return;
    if (filterParam) {
      setFilter(normalizeReviewFilter(filterParam));
      return;
    }
    api.frameStats(id).then((stats) => {
      if (countSampleReview(stats) > 0) setFilter("sample");
      else if (countPendingReview(stats) > 0) setFilter("pending");
      else if (countRejected(stats) > 0) setFilter("rejected");
      else if (countConfirmed(stats) > 0) setFilter("confirmed");
      else setFilter("all");
    });
  }, [id, filterParam]);

  useEffect(() => {
    if (!id) return;
    api.listPublicDatasetImports(id)
      .then((imports) => {
        setPublicImports(imports.filter((item) => item.state !== "discarded"));
      })
      .catch(() => setPublicImports([]));
  }, [id]);

  const startTrainingFromReview = async () => {
    if (!id || approvingTrain) return;
    setApprovingTrain(true);
    try {
      if (hasPublicReviewGate) {
        await api.approveProjectPublicDatasetsAndTrain(id);
        toast({ type: "success", message: "项目抽样复核通过，已合并全部公开数据并启动训练" });
      }
      router.push(`/projects/${id}/train`);
    } catch (error) {
      toast({ type: "error", message: `${error}` });
    } finally {
      setApprovingTrain(false);
    }
  };

  const loadFrames = useCallback(() => {
    if (!id || filter === null) return;
    api.listFramesPage(id, reviewStatuses(filter)).then((page) => {
      const f = page.items;
      setFrames(f);
      setNextCursor(page.next_cursor);
      setPageTotal(page.total);
      if (frameParam) {
        const i = f.findIndex((x) => x.id === frameParam);
        setIdx(i >= 0 ? i : 0);
      } else {
        setIdx((i) => Math.min(i, Math.max(0, f.length - 1)));
      }
    });
  }, [id, filter, frameParam]);

  const loadNextPage = useCallback(async () => {
    if (!id || filter === null || !nextCursor || loadingNext) return;
    setLoadingNext(true);
    try {
      const page = await api.listFramesPage(id, reviewStatuses(filter), nextCursor);
      setFrames((currentFrames) => {
        const existing = new Set(currentFrames.map((frame) => frame.id));
        return [...currentFrames, ...page.items.filter((frame) => !existing.has(frame.id))];
      });
      setNextCursor(page.next_cursor);
      setPageTotal(page.total);
    } finally {
      setLoadingNext(false);
    }
  }, [filter, id, loadingNext, nextCursor]);

  const refreshMeta = useCallback(() => {
    if (!id) return;
    api.frameStats(id).then(setFrameStats);
    api.listTasks(id).then((t) => {
      const reviewTasks = t.filter((x) => x.task_type === "review");
      setTasks(reviewTasks);
      const reviewRunning = t.some((x) => x.task_type === "review" && x.status === "running");
      setRunning(reviewRunning);
      const lastReview = reviewTasks.find((x) => x.status === "completed");
      if (prevReviewRunning.current && !reviewRunning && lastReview) {
        const count = Number(lastReview.result?.pass ?? lastReview.progress ?? 0);
        if (count > 0) {
          setReviewDoneBanner(count);
          setFilter("pending");
          setIdx(0);
          loadFrames();
        }
      }
      prevReviewRunning.current = reviewRunning;
    });
  }, [id, loadFrames]);

  useEffect(() => {
    refreshMeta();
    const t = setInterval(refreshMeta, running ? 2000 : 8000);
    return () => clearInterval(t);
  }, [refreshMeta, running]);

  useEffect(() => {
    if (!isEditing) loadFrames();
  }, [filter, isEditing, loadFrames]);

  const current = frames[idx];

  useEffect(() => {
    if (!id || frames.length === 0) return;
    const preload = (i: number) => {
      if (i < 0 || i >= frames.length) return;
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.src = api.frameImageUrl(id, frames[i].id, false);
    };
    preload(idx - 2);
    preload(idx - 1);
    preload(idx + 1);
    preload(idx + 2);
  }, [id, frames, idx]);

  useEffect(() => {
    if (nextCursor && idx >= frames.length - 10) void loadNextPage();
  }, [frames.length, idx, loadNextPage, nextCursor]);

  useEffect(() => {
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!isEditing) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const guardLinks = (event: MouseEvent) => {
      if (!isEditing) return;
      const link = (event.target as HTMLElement).closest("a");
      if (link && !window.confirm("当前标注尚未保存，确定离开吗？")) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    document.addEventListener("click", guardLinks, true);
    return () => {
      window.removeEventListener("beforeunload", warnBeforeUnload);
      document.removeEventListener("click", guardLinks, true);
    };
  }, [isEditing]);

  const confirmDiscard = useCallback(
    () => !isEditing || window.confirm("当前标注尚未保存，确定放弃修改吗？"),
    [isEditing],
  );

  const goFrame = useCallback((next: number) => {
    if (!confirmDiscard()) return;
    setIsEditing(false);
    if (next >= frames.length && nextCursor) {
      void loadNextPage().then(() => setIdx(Math.min(next, pageTotal - 1)));
    } else {
      setIdx(Math.max(0, Math.min(next, frames.length - 1)));
    }
  }, [confirmDiscard, frames.length, loadNextPage, nextCursor, pageTotal]);

  const switchFilter = (next: ReviewFilter) => {
    if (!confirmDiscard()) return;
    setIsEditing(false);
    draftsRef.current.clear();
    setFilter(next);
    setIdx(0);
    setShowRelabel(false);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "ArrowLeft") goFrame(idx - 1);
      if (e.key === "ArrowRight") goFrame(idx + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goFrame, idx]);

  // 切换当前帧时，把底部缩略图滚到可视区中间，避免选中项跑出屏幕外
  useEffect(() => {
    const strip = filmstripRef.current;
    const thumb = activeThumbRef.current;
    if (!strip || !thumb) return;

    const frame = requestAnimationFrame(() => {
      const stripRect = strip.getBoundingClientRect();
      const thumbRect = thumb.getBoundingClientRect();
      const delta =
        thumbRect.left + thumbRect.width / 2 - (stripRect.left + stripRect.width / 2);
      if (Math.abs(delta) < 1) return;
      strip.scrollBy({ left: delta, behavior: "smooth" });
    });

    return () => cancelAnimationFrame(frame);
  }, [idx, frames.length]);

  const handleSave = async (annotations: Annotation[], frameStatus: string) => {
    if (!id || !current) return;
    const frameId = current.id;
    try {
      if (frameStatus === "no_target") {
        await api.updateAnnotations(id, frameId, [], "no_target");
      } else {
        await api.updateAnnotations(id, frameId, annotations, frameStatus);
      }
      const nextFrames = frames.filter((f) => f.id !== frameId);
      setFrames(nextFrames);
      setPageTotal((total) => Math.max(0, total - 1));
      setConfirmedInSession((n) => n + 1);
      setIsEditing(false);
      draftsRef.current.delete(frameId);
      if (idx >= nextFrames.length) setIdx(Math.max(0, nextFrames.length - 1));
      refreshMeta();
    } catch (error) {
      toast({ type: "error", message: `保存失败：${error}` });
      throw error;
    }
  };

  const startAutoReview = async () => {
    if (!id) return;
    setActionError("");
    setReviewDoneBanner(null);
    try {
      await api.createTask(id, "review", {});
      refreshMeta();
    } catch (e) {
      setActionError(String(e));
    }
  };

  const stopReview = async () => {
    if (!id) return;
    setStopping(true);
    try {
      if (activeTask) await api.cancelTask(id, activeTask.id);
      else await api.cancelRunningTask(id);
      refreshMeta();
    } catch (e) {
      setActionError(String(e));
    } finally {
      setStopping(false);
    }
  };

  if (!project || filter === null) {
    return (
      <div className="review-loading-state">
        <LoadingScreen fullScreen={false} message="正在加载复查任务…" />
      </div>
    );
  }

  const activeFilterMeta = REVIEW_FILTERS.find((f) => f.value === filter);
  const sessionMinutes = Math.max(1, Math.round((Date.now() - sessionStart.current) / 60000));
  const reviewCopy = WORKFLOW_STEPS.find((step) => step.slug === "review")!;
  const sampleCount = countSampleReview(frameStats);
  // auto_ok 可直接训练，不阻塞「下一步」；仅 needs_human / llm_labeled / auto_fixed 需人工处理
  const blockingCount = countBlockingReview(frameStats);
  const trainableCount = countTrainable(frameStats);
  const canGoTrain = blockingCount === 0 && trainableCount > 0;
  const reviewHeaderAction = canGoTrain ? (
    hasPublicReviewGate ? (
      <button
        type="button"
        className="materials-workspace__next-action materials-workspace__next-action--ready"
        disabled={approvingTrain}
        onClick={() => void startTrainingFromReview()}
      >
        <Icon name="check" size={16} />
        <div className="flex flex-col items-start leading-tight">
          <span className="text-[10px] opacity-80 font-normal">下一步</span>
          <strong>{approvingTrain ? "正在进入…" : "训练或导出"}</strong>
        </div>
      </button>
    ) : (
      <WorkflowNextButton href={`/projects/${id}/train`} label="训练或导出" />
    )
  ) : (
    <WorkflowNextButton
      label="训练或导出"
      disabled
      disabledHint={
        sampleCount > 0
          ? `抽样复核剩余 ${sampleCount} 张`
          : blockingCount > 0
            ? `待复核 ${blockingCount} 张`
            : "等待确认"
      }
    />
  );

  if (filter === "sample" && frames.length === 0 && countSampleReview(frameStats) === 0) {
    return (
      <div className="review-page min-h-[calc(100vh-64px)] bg-[#f4faf8] text-[#17343A] font-sans flex flex-col relative overflow-hidden p-8">
        <div className="absolute top-[-20%] left-[-10%] w-[600px] h-[600px] bg-[#10A88F]/10 blur-[120px] rounded-full pointer-events-none" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[500px] h-[500px] bg-[#078D82]/10 blur-[100px] rounded-full pointer-events-none" />
        <div className="relative z-10 flex flex-col h-full w-full">
        <ProjectPageHeader
          title="标注复核"
          eyebrow="Quality assurance"
          description={reviewCopy.pageDescription}
          action={reviewHeaderAction}
        />
        <div className="flex-1 bg-white/80 backdrop-blur-xl border border-white shadow-[0_8px_32px_rgba(16,168,143,0.06)] rounded-2xl p-10 flex flex-col items-center justify-center text-center">
            <div className="w-16 h-16 bg-[#F4FAF8] rounded-2xl flex items-center justify-center mb-6 shadow-inner border border-[#CFF4EC]">
              <Icon name="check" size={32} className="text-[#10A88F]" />
            </div>
            <h2 className="text-xl font-bold text-[#075F5A] mb-3">抽样复查完成</h2>
            <p className="text-[#17343A]/60 max-w-md mx-auto mb-8 leading-relaxed">
              风险样本已全部确认（本次处理 {confirmedInSession} 张）。<br />
              点击下方按钮创建不可变数据版本并开始训练。
            </p>
            <div className="flex gap-4 flex-wrap justify-center">
              <button
                type="button"
                className="px-6 py-2.5 bg-[#10A88F] text-white rounded-xl text-sm font-bold shadow-sm shadow-[#10A88F]/20 hover:bg-[#078D82] transition-colors disabled:opacity-50"
                disabled={approvingTrain}
                onClick={() => void startTrainingFromReview()}
              >
                {approvingTrain
                  ? "正在创建版本并启动训练…"
                  : publicImports.some((item) => item.state === "training")
                    ? "查看训练进度"
                    : "创建版本并开始训练"}
              </button>
              <button type="button" className="px-6 py-2.5 bg-white border border-[#e4e7ec] text-[#344054] rounded-xl text-sm font-bold hover:bg-gray-50 transition-colors shadow-sm" onClick={() => switchFilter("confirmed")}>
                查看已确认
              </button>
            </div>
        </div>
        </div>
      </div>
    );
  }

  if (filter === "pending" && frames.length === 0 && pendingCount === 0 && confirmedCount > 0) {
    return (
      <div className="review-page min-h-[calc(100vh-64px)] bg-[#f4faf8] text-[#17343A] font-sans flex flex-col relative overflow-hidden p-8">
        <div className="absolute top-[-20%] left-[-10%] w-[600px] h-[600px] bg-[#10A88F]/10 blur-[120px] rounded-full pointer-events-none" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[500px] h-[500px] bg-[#078D82]/10 blur-[100px] rounded-full pointer-events-none" />
        <div className="relative z-10 flex flex-col h-full w-full">
        <ProjectPageHeader
          title="标注复核"
          eyebrow="Quality assurance"
          description={reviewCopy.pageDescription}
          action={reviewHeaderAction}
        />
        <div className="flex-1 bg-white/80 backdrop-blur-xl border border-white shadow-[0_8px_32px_rgba(16,168,143,0.06)] rounded-2xl p-10 flex flex-col items-center justify-center text-center">
            <div className="w-16 h-16 bg-[#F4FAF8] rounded-2xl flex items-center justify-center mb-6 shadow-inner border border-[#CFF4EC]">
              <Icon name="check" size={32} className="text-[#10A88F]" />
            </div>
            <h2 className="text-xl font-bold text-[#075F5A] mb-3">人工确认完成</h2>
            <p className="text-[#17343A]/60 max-w-md mx-auto mb-8">
              已确认 {confirmedCount} 张 · 本次处理 {confirmedInSession} 张 · 约 {sessionMinutes} 分钟
            </p>
            <div className="flex gap-4 flex-wrap justify-center">
              <Link href={`/projects/${id}/train`} className="px-6 py-2.5 bg-[#10A88F] text-white rounded-xl text-sm font-bold shadow-sm shadow-[#10A88F]/20 hover:bg-[#078D82] transition-colors">
                开始训练
              </Link>
              <button type="button" className="px-6 py-2.5 bg-white border border-[#e4e7ec] text-[#344054] rounded-xl text-sm font-bold hover:bg-gray-50 transition-colors shadow-sm" onClick={() => switchFilter("confirmed")}>
                查看已确认
              </button>
            </div>
        </div>
        </div>
      </div>
    );
  }

  return (
    <div className="review-page min-h-[calc(100vh-64px)] h-[calc(100vh-64px)] bg-[#f4faf8] text-[#17343A] font-sans flex flex-col relative overflow-hidden p-4 lg:p-5">
      <div className="absolute top-[-20%] left-[-10%] w-[600px] h-[600px] bg-[#10A88F]/10 blur-[120px] rounded-full pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[500px] h-[500px] bg-[#078D82]/10 blur-[100px] rounded-full pointer-events-none" />

      <div className="relative z-10 flex flex-col h-full min-h-0 w-full">
        <ProjectPageHeader
          title="标注复核"
          eyebrow="Quality assurance"
          description={reviewCopy.pageDescription}
          action={reviewHeaderAction}
        />

        {actionError && (
          <div className="mb-4 bg-red-50 border border-red-100 text-red-600 px-4 py-3 rounded-xl text-sm shadow-sm shrink-0">{actionError}</div>
        )}
        {reviewDoneBanner !== null && (
          <div className="mb-4 bg-[#F4FAF8] border border-[#CFF4EC] text-[#075F5A] px-4 py-3 rounded-xl text-sm shadow-sm shrink-0">
            机器预审完成 {reviewDoneBanner} 张，请继续逐张确认
          </div>
        )}

        {showAutoReview && (
          <div className="mb-4 bg-white/80 backdrop-blur-xl border border-white shadow-[0_8px_32px_rgba(16,168,143,0.06)] rounded-2xl p-5 shrink-0">
            <TaskProgress
              label="审查进度"
              progress={activeTask?.progress ?? 0}
              total={activeTask?.total ?? 0}
              onStop={running ? stopReview : undefined}
              stopping={stopping}
            />
            {!running && (
              <button
                type="button"
                className="mt-4 px-6 py-2.5 bg-white border border-[#e4e7ec] text-[#344054] rounded-xl text-sm font-bold hover:bg-gray-50 transition-colors shadow-sm disabled:opacity-50"
                disabled={reviewable === 0}
                onClick={startAutoReview}
              >
                开始自动审查
              </button>
            )}
          </div>
        )}

        <div className="flex-1 flex flex-col min-h-0 bg-white/40 backdrop-blur-3xl rounded-3xl border border-white shadow-[0_8px_32px_rgba(16,168,143,0.06)] p-2">
          <div className="flex justify-between items-center mb-2 shrink-0 bg-white/80 rounded-2xl p-2 shadow-sm border border-white">
            <div className="flex items-center gap-1 overflow-x-auto custom-scrollbar">
              {REVIEW_FILTERS.map((f) => {
                const count =
                  f.value === "sample" ? sampleCount :
                  f.value === "pending" ? pendingCount :
                  f.value === "rejected" ? rejectedCount :
                  f.value === "confirmed" ? confirmedCount : null;
                const isActive = filter === f.value;
                return (
                  <button
                    key={f.value}
                    type="button"
                    className={`px-4 py-2 rounded-xl text-sm font-bold transition-all shrink-0 ${
                      isActive
                        ? "bg-[#F4FAF8] text-[#10A88F] shadow-sm border border-[#CFF4EC]/50"
                        : "text-[#17343A]/60 hover:text-[#075F5A] hover:bg-gray-50 border border-transparent"
                    }`}
                    onClick={() => switchFilter(f.value)}
                  >
                    {f.label}{count != null && count > 0 ? ` (${count})` : ""}
                  </button>
                );
              })}
            </div>
            <div className="flex items-center gap-2 px-2 shrink-0">
              {frames.length > 0 && (
                <span className="text-sm font-bold text-[#17343A]/50 bg-gray-50 px-3 py-1.5 rounded-lg border border-gray-100">
                  {idx + 1} <span className="text-[#17343A]/30 font-normal">/ {pageTotal}</span>
                  {confirmedInSession > 0 && (
                    <span className="text-[#17343A]/30 font-normal"> · 本次 {confirmedInSession}</span>
                  )}
                </span>
              )}
              <button
                type="button"
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors shadow-sm ${
                  showAutoReview
                    ? "bg-[#F4FAF8] text-[#10A88F] border border-[#CFF4EC]"
                    : "bg-white border border-[#e4e7ec] text-[#344054] hover:bg-gray-50"
                }`}
                onClick={() => setShowAutoReview((v) => !v)}
              >
                <Icon name="sparkles" size={14} className="text-[#10A88F]" />
                机器预审
              </button>
              {filter === "rejected" && rejectedCount > 0 && (
                <button
                  type="button"
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors shadow-sm ${
                    showRelabel
                      ? "bg-[#F4FAF8] text-[#10A88F] border border-[#CFF4EC]"
                      : "bg-white border border-[#e4e7ec] text-[#344054] hover:bg-gray-50"
                  }`}
                  onClick={() => setShowRelabel((v) => !v)}
                >
                  批量重标
                </button>
              )}
            </div>
          </div>

          {showRelabel && filter === "rejected" && rejectedCount > 0 && (
            <div className="mb-2 shrink-0 bg-white/80 backdrop-blur-xl border border-white shadow-sm rounded-2xl p-4 mx-0">
              <div className="flex items-center justify-between gap-4 mb-3">
                <h3 className="text-sm font-bold text-[#075F5A]">驳回修正</h3>
                <SegmentedControl
                  options={[
                    { value: "yolo" as const, label: "YOLO" },
                    { value: "llm" as const, label: "LLM" },
                  ]}
                  value={relabelMode}
                  onChange={setRelabelMode}
                />
              </div>
              {relabelMode === "yolo" ? (
                <YoloLabelPanel
                  projectId={id!}
                  frameStats={frameStats}
                  fixedOnlyStatus="human_wrong"
                  compact
                  onDone={loadFrames}
                />
              ) : (
                <LlmLabelPanel
                  projectId={id!}
                  frameStats={frameStats}
                  fixedOnlyStatus="human_wrong"
                  compact
                  onDone={() => {
                    refreshMeta();
                    switchFilter("pending");
                  }}
                />
              )}
            </div>
          )}

          {frames.length === 0 ? (
            <div className="flex-1 flex items-center justify-center m-2 bg-white/80 rounded-2xl border border-white shadow-sm min-h-0">
              <EmptyState
                title={`「${activeFilterMeta?.label}」暂无图片`}
                description={filter === "pending" && confirmedCount > 0 ? "可以尝试查看已确认或开始训练" : undefined}
                action={
                  filter === "pending" && confirmedCount > 0 ? (
                    <Link href={`/projects/${id}/train`} className="bg-[#10A88F] text-white px-6 py-2.5 rounded-xl text-sm font-bold shadow-sm shadow-[#10A88F]/20 hover:bg-[#078D82] transition-colors inline-block mt-4">
                      开始训练
                    </Link>
                  ) : undefined
                }
              />
            </div>
          ) : (
            <div className="flex-1 flex flex-col min-h-0 gap-2">
              <div className={`review-canvas-wrap review-canvas-wrap--${project.task_type} flex-1 min-h-0`}>
                <div className="review-canvas h-full min-h-0">
                  {current && (
                    <AnnotationEditor
                      key={current.id}
                      frameId={current.id}
                      imageUrl={api.frameImageUrl(id!, current.id, false)}
                      categories={project.categories}
                      annotations={current.annotations}
                      taskType={project.task_type}
                      onSave={handleSave}
                      onDirtyChange={setIsEditing}
                      darkCanvas
                      compact
                      sidePanel={annotationSidePanel}
                      actionPanel={annotationActionPanel}
                    />
                  )}
                </div>
                <aside className="review-side h-full min-h-0">
                  {current && (
                    <>
                      <span className="text-[10px] font-bold tracking-wider text-[#10A88F] uppercase">当前帧</span>
                      <h2 className="text-sm font-bold text-[#075F5A] truncate mt-1" title={current.filename}>{current.filename}</h2>
                      <span className="review-side__status mt-2">
                        <i aria-hidden="true" />
                        {FRAME_STATUS_SIMPLE[current.status] ?? current.status}
                      </span>
                      {current.review_note && (
                        <p className="review-side__note">
                          <strong>审查提示：</strong>
                          {current.review_note}
                        </p>
                      )}
                      <div ref={setAnnotationActionPanel} className="review-side__actions mt-4 shrink-0" />
                      <div ref={setAnnotationSidePanel} className="review-side__annotations mt-3 min-h-0 flex-1" />
                    </>
                  )}
                </aside>
              </div>
              <div
                ref={filmstripRef}
                className="h-[104px] shrink-0 bg-white/80 rounded-2xl border border-white shadow-sm flex items-center px-2 overflow-x-auto overflow-y-hidden custom-scrollbar"
              >
                <div className="flex gap-2 items-center h-full py-2">
                  {frames.slice(Math.max(0, idx - 50), Math.min(frames.length, idx + 51)).map((f, offset) => {
                    const i = Math.max(0, idx - 50) + offset;
                    const selected = i === idx;
                    return (
                      <div
                        key={f.id}
                        ref={selected ? activeThumbRef : undefined}
                        className={`h-full aspect-video shrink-0 rounded-lg overflow-hidden cursor-pointer transition-all border-2 relative ${
                          selected
                            ? "border-[#10A88F] shadow-md ring-2 ring-[#10A88F]/20 scale-105 z-10"
                            : "border-transparent hover:border-[#CFF4EC] shadow-sm opacity-60 hover:opacity-100"
                        }`}
                        onClick={() => goFrame(i)}
                      >
                        <img src={api.frameImageUrl(id!, f.id, true)} alt={f.filename} className="w-full h-full object-cover" />
                        <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/70 via-black/35 to-transparent px-1.5 py-1 flex justify-center">
                          <span className="text-[9px] font-bold text-white whitespace-nowrap leading-none">
                            {FRAME_STATUS_SIMPLE[f.status] ?? f.status}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                  {loadingNext && <span className="text-xs text-[#17343A]/40 px-4 whitespace-nowrap">加载下一页…</span>}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
