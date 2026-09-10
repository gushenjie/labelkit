"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { useConfirm } from "@/components/ui/ConfirmDialog";
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
  visibleReviewFilters,
} from "@/lib/status";
import {
  matchesProjectLiveEvent,
  PROJECT_STATS_REFRESH_EVENT,
  requestProjectStatsRefresh,
} from "@/lib/project-live";

/** 胶片条窗口：缩小并发，避免挤占主图画布带宽 */
const FILMSTRIP_RADIUS = 8;
const FILMSTRIP_MAX_EDGE = 320;

/** 始终凑满约 2R+1 张；贴左边/右边时向另一侧补齐，避免首页右侧空一格 */
function getFilmstripBounds(idx: number, length: number, radius: number) {
  const windowSize = Math.min(length, radius * 2 + 1);
  let start = Math.max(0, idx - radius);
  let end = Math.min(length, start + windowSize);
  start = Math.max(0, end - windowSize);
  return { start, end };
}

function FilmstripThumb({
  src,
  alt,
  staggerMs,
  allowLoad,
}: {
  src: string;
  alt: string;
  staggerMs: number;
  allowLoad: boolean;
}) {
  const [activeSrc, setActiveSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!allowLoad) {
      setActiveSrc(null);
      return;
    }
    if (staggerMs <= 0) {
      setActiveSrc(src);
      return;
    }
    const timer = window.setTimeout(() => setActiveSrc(src), staggerMs);
    return () => window.clearTimeout(timer);
  }, [allowLoad, src, staggerMs]);

  if (!activeSrc) {
    return <div className="w-full h-full bg-[#E8F2EF]" aria-hidden="true" />;
  }

  return (
    <img
      src={activeSrc}
      alt={alt}
      // 横滑胶片条不要用原生 lazy：边缘格会被当成「屏外」一直不加载
      loading="eager"
      decoding="async"
      className="w-full h-full object-cover"
    />
  );
}

export default function ReviewPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const frameParam = searchParams.get("frame");
  const filterParam = searchParams.get("filter") ?? searchParams.get("status");
  const publicImportId = searchParams.get("publicImport");
  const { toast } = useToast();
  const confirm = useConfirm();

  const [project, setProject] = useState<Project | null>(null);
  const [frames, setFrames] = useState<Frame[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [pageTotal, setPageTotal] = useState(0);
  const [loadingNext, setLoadingNext] = useState(false);
  const [frameStats, setFrameStats] = useState<Record<string, number>>({});
  const [statsLoaded, setStatsLoaded] = useState(false);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [actionError, setActionError] = useState("");
  const [reviewDoneBanner, setReviewDoneBanner] = useState<number | null>(null);
  const prevReviewRunning = useRef(false);
  const draftsRef = useRef<Map<string, Annotation[]>>(new Map());
  const sessionStart = useRef(Date.now());
  const [confirmedInSession, setConfirmedInSession] = useState(0);

  const [filter, setFilter] = useState<ReviewFilter | null>(() =>
    filterParam ? normalizeReviewFilter(filterParam) : null,
  );
  const [idx, setIdx] = useState(0);
  const [isEditing, setIsEditing] = useState(false);
  const [showAutoReview, setShowAutoReview] = useState(false);
  const [showRelabel, setShowRelabel] = useState(false);
  const [relabelMode, setRelabelMode] = useState<"yolo" | "llm">("yolo");
  const filmstripRef = useRef<HTMLDivElement>(null);
  const activeThumbRef = useRef<HTMLButtonElement>(null);
  const [annotationSidePanel, setAnnotationSidePanel] = useState<HTMLDivElement | null>(null);
  const [annotationActionPanel, setAnnotationActionPanel] = useState<HTMLDivElement | null>(null);
  const [publicImports, setPublicImports] = useState<PublicDatasetImport[]>([]);
  const [approvingTrain, setApprovingTrain] = useState(false);
  const [mainImageReady, setMainImageReady] = useState(false);
  const [batchConfirming, setBatchConfirming] = useState(false);
  const manualMode = filter === "manual";

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
  const visibleFilters = useMemo(() => visibleReviewFilters(frameStats), [frameStats]);

  useEffect(() => {
    if (!filter || !statsLoaded) return;
    if (visibleFilters.includes(filter)) return;
    // URL 明确指定的工作队列应保留到完成态，不能因数量归零跳到另一类完成页。
    if (filterParam && normalizeReviewFilter(filterParam) === filter) return;
    setFilter(visibleFilters[0] ?? "all");
  }, [filter, filterParam, statsLoaded, visibleFilters]);

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
      setFrameStats(stats);
      setStatsLoaded(true);
      const visible = visibleReviewFilters(stats);
      if (visible.includes("sample")) setFilter("sample");
      else if (visible.includes("pending")) setFilter("pending");
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
      if (publicImportId) {
        const approved = await api.approvePublicDatasetReview(id, publicImportId);
        toast({ type: "success", message: "本批公开数据已通过抽检并回到素材总账" });
        router.push(`/projects/${id}/materials?highlight=${approved.material_batch_id ?? ""}`);
        return;
      }
      if (hasPublicReviewGate) {
        const first = pendingReviewImports[0];
        if (first) router.push(`/projects/${id}/review?filter=sample&publicImport=${first.id}`);
        return;
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
    api.listFramesPage(id, reviewStatuses(filter), null, "uncertainty", { publicImportId: publicImportId ?? undefined }).then((page) => {
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
  }, [id, filter, frameParam, publicImportId]);

  const loadNextPage = useCallback(async () => {
    if (!id || filter === null || !nextCursor || loadingNext) return;
    setLoadingNext(true);
    try {
      const page = await api.listFramesPage(id, reviewStatuses(filter), nextCursor, "uncertainty", { publicImportId: publicImportId ?? undefined });
      setFrames((currentFrames) => {
        const existing = new Set(currentFrames.map((frame) => frame.id));
        return [...currentFrames, ...page.items.filter((frame) => !existing.has(frame.id))];
      });
      setNextCursor(page.next_cursor);
      setPageTotal(page.total);
    } finally {
      setLoadingNext(false);
    }
  }, [filter, id, loadingNext, nextCursor, publicImportId]);

  const refreshMeta = useCallback(() => {
    if (!id) return;
    api.frameStats(id).then((stats) => {
      setFrameStats(stats);
      setStatsLoaded(true);
    });
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
    if (!running) return;
    const t = setInterval(refreshMeta, 2000);
    return () => clearInterval(t);
  }, [refreshMeta, running]);

  useEffect(() => {
    if (!id) return;
    const onRefresh = (event: Event) => {
      if (!matchesProjectLiveEvent(event, id)) return;
      refreshMeta();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") refreshMeta();
    };
    window.addEventListener(PROJECT_STATS_REFRESH_EVENT, onRefresh);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener(PROJECT_STATS_REFRESH_EVENT, onRefresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [id, refreshMeta]);

  useEffect(() => {
    if (!isEditing) loadFrames();
  }, [filter, isEditing, loadFrames]);

  const current = frames[idx];

  useEffect(() => {
    setMainImageReady(false);
  }, [current?.id]);

  useEffect(() => {
    if (!id || frames.length === 0 || !mainImageReady) return;
    const preload = (i: number) => {
      if (i < 0 || i >= frames.length) return;
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.src = api.frameImageUrl(id, frames[i].id, false);
    };
    preload(idx - 1);
    preload(idx + 1);
  }, [id, frames, idx, mainImageReady]);

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
      requestProjectStatsRefresh(id);
    } catch (error) {
      toast({ type: "error", message: `保存失败：${error}` });
      throw error;
    }
  };

  const batchConfirmCount =
    filter === "sample"
      ? publicImportId
        ? pageTotal
        : countSampleReview(frameStats)
      : filter === "pending"
        ? pendingCount
        : filter === "rejected"
          ? rejectedCount
          : 0;
  const canBatchConfirm =
    (filter === "sample" || filter === "pending" || filter === "rejected") && batchConfirmCount > 0;

  const handleBatchConfirm = async () => {
    if (!id || !filter || !canBatchConfirm) return;
    if (!confirmDiscard()) return;
    const filterLabel = publicImportId && filter === "sample"
      ? "本批公开数据抽检"
      : REVIEW_FILTERS.find((f) => f.value === filter)?.label ?? "当前筛选";
    const ok = await confirm({
      title: "一键确认",
      message: `将「${filterLabel}」下剩余 ${batchConfirmCount} 张全部标记为已确认，保留现有标注且不再逐张查看。确定继续？`,
      confirmLabel: "全部确认",
    });
    if (!ok) return;
    setBatchConfirming(true);
    setActionError("");
    try {
      const result = await api.batchFrameFeedback(id, reviewStatuses(filter), "human_ok", {
        publicImportId: publicImportId ?? undefined,
      });
      setConfirmedInSession((n) => n + (result.updated ?? 0));
      setIsEditing(false);
      draftsRef.current.clear();
      setIdx(0);
      toast({ type: "success", message: `已确认 ${result.updated} 张` });
      loadFrames();
      refreshMeta();
      requestProjectStatsRefresh(id);
    } catch (error) {
      toast({ type: "error", message: `一键确认失败：${error}` });
    } finally {
      setBatchConfirming(false);
    }
  };

  const startAutoReview = async () => {
    if (!id) return;
    setActionError("");
    setReviewDoneBanner(null);
    try {
      await api.createTask(id, "review", {});
      refreshMeta();
      requestProjectStatsRefresh(id);
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
  const unlabeledCount = frameStats.unlabeled ?? 0;
  const canGoTrain = unlabeledCount === 0 && blockingCount === 0 && trainableCount > 0;
  const batchReviewComplete = Boolean(publicImportId && pageTotal === 0);
  const reviewHeaderAction = manualMode && unlabeledCount > 0 ? (
    <WorkflowNextButton
      label="标注复核"
      disabled
      disabledHint={`还剩 ${unlabeledCount} 张待人工标注`}
    />
  ) : publicImportId ? (
    <button
      type="button"
      className="materials-workspace__next-action materials-workspace__next-action--ready"
      disabled={approvingTrain || !batchReviewComplete}
      title={batchReviewComplete ? "" : `本批仍有 ${pageTotal} 张待复核`}
      onClick={() => void startTrainingFromReview()}
    >
      <Icon name="check" size={16} />
      <div className="flex flex-col items-start leading-tight">
        <span className="text-[10px] opacity-80 font-normal">完成本批抽检</span>
        <strong>{approvingTrain ? "正在提交…" : "确认并返回素材"}</strong>
      </div>
    </button>
  ) : canGoTrain ? (
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

  if (filter === "sample" && frames.length === 0 && (publicImportId ? pageTotal === 0 : countSampleReview(frameStats) === 0)) {
    return (
      <div className="review-page min-h-[calc(100vh-64px)] bg-[#f4faf8] text-[#17343A] font-sans flex flex-col relative overflow-hidden p-8">
        <div className="absolute top-[-20%] left-[-10%] w-[600px] h-[600px] bg-[#10A88F]/10 blur-[120px] rounded-full pointer-events-none" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[500px] h-[500px] bg-[#078D82]/10 blur-[100px] rounded-full pointer-events-none" />
        <div className="relative z-10 flex flex-col h-full w-full">
        <ProjectPageHeader
          title={publicImportId ? "公开数据抽检" : "标注复核"}
          eyebrow={publicImportId ? "Dataset quality check" : "Quality assurance"}
          description={publicImportId ? "核对本批公开数据的抽检样本；确认后保留原有标注并返回素材总账。" : reviewCopy.pageDescription}
          action={reviewHeaderAction}
        />
        <div className="flex-1 bg-white/80 backdrop-blur-xl border border-white shadow-[0_8px_32px_rgba(16,168,143,0.06)] rounded-2xl p-10 flex flex-col items-center justify-center text-center">
            <div className="w-16 h-16 bg-[#F4FAF8] rounded-2xl flex items-center justify-center mb-6 shadow-inner border border-[#CFF4EC]">
              <Icon name="check" size={32} className="text-[#10A88F]" />
            </div>
            <h2 className="text-xl font-bold text-[#075F5A] mb-3">{publicImportId ? "本批公开数据抽检完成" : "抽样复查完成"}</h2>
            <p className="text-[#17343A]/60 max-w-md mx-auto mb-8 leading-relaxed">
              {publicImportId ? "本批抽检样本均已确认，原有标注已保留。" : `风险样本已全部确认（本次处理 ${confirmedInSession} 张）。`}<br />
              {publicImportId ? "确认抽检结果后，该批次会回到素材总账；全部素材准备完成后再统一训练。" : "当前抽样复核已完成。"}
            </p>
            <div className="flex gap-4 flex-wrap justify-center">
              <button
                type="button"
                className="px-6 py-2.5 bg-[#10A88F] text-white rounded-xl text-sm font-bold shadow-sm shadow-[#10A88F]/20 hover:bg-[#078D82] transition-colors disabled:opacity-50"
                disabled={approvingTrain}
                onClick={() => void startTrainingFromReview()}
              >
                {approvingTrain ? "正在提交…" : publicImportId ? "确认抽检并返回素材" : "训练或导出"}
              </button>
              <button type="button" className="px-6 py-2.5 bg-white border border-[#e4e7ec] text-[#344054] rounded-xl text-sm font-bold hover:bg-gray-50 transition-colors shadow-sm" onClick={() => switchFilter("confirmed")}>
                {publicImportId ? "查看本批已确认" : "查看已确认"}
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
          title={manualMode ? "人工标注" : "标注复核"}
          eyebrow={manualMode ? "Manual annotation" : "Quality assurance"}
          description={manualMode ? "逐张绘制或调整标注；保存后直接记为人工确认，不再经过 AI 预标注。" : reviewCopy.pageDescription}
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

        {showAutoReview && !manualMode && (
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
              {REVIEW_FILTERS.filter((f) => visibleFilters.includes(f.value)).map((f) => {
                const count =
                  f.value === "manual" ? unlabeledCount :
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
              {!manualMode && (
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
              )}
              {canBatchConfirm && (
                <button
                  type="button"
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-bold transition-colors shadow-sm bg-[#10A88F] text-white hover:bg-[#078D82] disabled:opacity-50"
                  disabled={batchConfirming}
                  onClick={() => void handleBatchConfirm()}
                >
                  {batchConfirming ? "确认中…" : `一键确认 (${batchConfirmCount})`}
                </button>
              )}
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
                description={manualMode ? "当前没有未标注素材，可以处理待确认结果或返回素材标注。" : filter === "pending" && confirmedCount > 0 ? "可以尝试查看已确认或开始训练" : undefined}
                action={
                  manualMode ? (
                    <Link href={`/projects/${id}/label`} className="bg-white border border-[#e4e7ec] text-[#344054] px-6 py-2.5 rounded-xl text-sm font-bold shadow-sm hover:bg-gray-50 transition-colors inline-block mt-4">
                      返回素材标注
                    </Link>
                  ) : filter === "pending" && confirmedCount > 0 ? (
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
                      onImageReadyChange={setMainImageReady}
                      darkCanvas
                      compact
                      sidePanel={annotationSidePanel}
                      actionPanel={annotationActionPanel}
                      workflowMode={manualMode ? "manual" : "review"}
                    />
                  )}
                </div>
                <aside className="review-side h-full min-h-0">
                  {current && (
                    <>
                      <span className="text-[10px] font-bold tracking-wider text-[#10A88F] uppercase">{manualMode ? "待人工标注" : "当前帧"}</span>
                      <div className="mt-1 flex items-start gap-1.5 min-w-0">
                        <h2 className="text-sm font-bold text-[#075F5A] truncate min-w-0 flex-1" title={current.filename}>
                          {current.filename}
                        </h2>
                        <button
                          type="button"
                          className="shrink-0 mt-0.5 p-1 rounded-md text-[#17343A]/45 hover:text-[#10A88F] hover:bg-[#F4FAF8] transition-colors"
                          title="复制文件名"
                          aria-label="复制文件名"
                          onClick={async () => {
                            try {
                              await navigator.clipboard.writeText(current.filename);
                              toast({ type: "success", message: "已复制文件名" });
                            } catch {
                              toast({ type: "error", message: "复制失败，请检查剪贴板权限" });
                            }
                          }}
                        >
                          <Icon name="copy" size={14} />
                        </button>
                      </div>
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
                <div className="flex gap-2 items-center h-full py-2 px-1">
                  {(() => {
                    const { start, end } = getFilmstripBounds(idx, frames.length, FILMSTRIP_RADIUS);
                    return frames.slice(start, end).map((f, offset) => {
                    const i = start + offset;
                    const selected = i === idx;
                    const distance = Math.abs(i - idx);
                    return (
                      <button
                        type="button"
                        key={f.id}
                        ref={selected ? activeThumbRef : undefined}
                        aria-label={`打开 ${f.filename}`}
                        aria-pressed={selected}
                        className={`h-full aspect-video shrink-0 p-0 bg-transparent rounded-lg overflow-hidden cursor-pointer transition-all border-2 relative ${
                          selected
                            ? "border-[#10A88F] shadow-md ring-2 ring-[#10A88F]/20 z-10"
                            : "border-transparent hover:border-[#CFF4EC] shadow-sm opacity-60 hover:opacity-100"
                        }`}
                        onClick={() => goFrame(i)}
                      >
                        <FilmstripThumb
                          src={api.frameImageUrl(id!, f.id, true, { maxEdge: FILMSTRIP_MAX_EDGE })}
                          alt={f.filename}
                          staggerMs={distance <= 1 ? 0 : Math.min(280, distance * 30)}
                          allowLoad={mainImageReady}
                        />
                        <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/70 via-black/35 to-transparent px-1.5 py-1 flex justify-center">
                          <span className="text-[9px] font-bold text-white whitespace-nowrap leading-none">
                            {FRAME_STATUS_SIMPLE[f.status] ?? f.status}
                          </span>
                        </div>
                      </button>
                    );
                  });
                  })()}
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
