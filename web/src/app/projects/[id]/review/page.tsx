"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, Annotation, Frame, Project, Task } from "@/lib/api";
import { AnnotationEditor } from "@/components/AnnotationEditor";
import { LlmLabelPanel } from "@/components/LlmLabelPanel";
import { YoloLabelPanel } from "@/components/YoloLabelPanel";
import { ProjectPageHeader } from "@/components/ProjectPageHeader";
import { Panel } from "@/components/ui/Panel";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { TaskProgress } from "@/components/ui/TaskProgress";
import { Thumb } from "@/components/ui/Thumb";
import { EmptyState } from "@/components/ui/EmptyState";
import { useToast } from "@/components/ui/ToastProvider";
import {
  countConfirmed,
  countPendingReview,
  countRejected,
  FRAME_STATUS_SIMPLE,
  normalizeReviewFilter,
  reviewStatuses,
  REVIEW_FILTERS,
  ReviewFilter,
} from "@/lib/status";

export default function ReviewPage() {
  const { id } = useParams<{ id: string }>();
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
  const [relabelMode, setRelabelMode] = useState<"yolo" | "llm">("yolo");

  const reviewable =
    (frameStats.llm_labeled ?? 0) + (frameStats.needs_human ?? 0) + (frameStats.auto_fixed ?? 0);
  const activeTask = tasks.find((t) => t.status === "running");
  const pendingCount = countPendingReview(frameStats);
  const rejectedCount = countRejected(frameStats);
  const confirmedCount = countConfirmed(frameStats);

  useEffect(() => {
    if (!id) return;
    if (filterParam) {
      setFilter(normalizeReviewFilter(filterParam));
      return;
    }
    api.frameStats(id).then((stats) => {
      if (countPendingReview(stats) > 0) setFilter("pending");
      else if (countRejected(stats) > 0) setFilter("rejected");
      else if (countConfirmed(stats) > 0) setFilter("confirmed");
      else setFilter("all");
    });
  }, [id, filterParam]);

  const loadFrames = useCallback(() => {
    if (!id || filter === null) return;
    api.getProject(id).then(setProject);
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
    loadFrames();
    const t = setInterval(refreshMeta, running ? 2000 : 8000);
    return () => clearInterval(t);
  }, [refreshMeta, loadFrames, running]);

  useEffect(() => {
    if (!isEditing) loadFrames();
  }, [filter, isEditing, loadFrames]);

  const current = frames[idx];

  useEffect(() => {
    if (!id || frames.length === 0) return;
    const preload = (i: number) => {
      if (i < 0 || i >= frames.length) return;
      const img = new Image();
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

  const confirmDiscard = () => !isEditing || window.confirm("当前标注尚未保存，确定放弃修改吗？");

  const goFrame = (next: number) => {
    if (!confirmDiscard()) return;
    setIsEditing(false);
    if (next >= frames.length && nextCursor) {
      void loadNextPage().then(() => setIdx(Math.min(next, pageTotal - 1)));
    } else {
      setIdx(Math.max(0, Math.min(next, frames.length - 1)));
    }
  };

  const switchFilter = (next: ReviewFilter) => {
    if (!confirmDiscard()) return;
    setIsEditing(false);
    draftsRef.current.clear();
    setFilter(next);
    setIdx(0);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "ArrowLeft") goFrame(Math.max(0, idx - 1));
      if (e.key === "ArrowRight") goFrame(idx + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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

  if (!project || filter === null) return <p>加载中…</p>;

  const activeFilterMeta = REVIEW_FILTERS.find((f) => f.value === filter);
  const sessionMinutes = Math.max(1, Math.round((Date.now() - sessionStart.current) / 60000));

  if (filter === "pending" && frames.length === 0 && pendingCount === 0 && confirmedCount > 0) {
    return (
      <div className="operations-page">
        <ProjectPageHeader title="人工确认" description="本批次待确认已全部完成" eyebrow="Quality assurance" />
        <Panel>
          <div className="review-complete">
            <h2>人工确认完成</h2>
            <p>已确认 {confirmedCount} 张 · 本次处理 {confirmedInSession} 张 · 约 {sessionMinutes} 分钟</p>
            <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 16 }}>
              <Link href={`/projects/${id}/train`} className="btn-primary">开始训练</Link>
              <button type="button" className="btn-secondary" onClick={() => switchFilter("confirmed")}>
                查看已确认
              </button>
            </div>
          </div>
        </Panel>
      </div>
    );
  }

  return (
    <div className="review-workspace">
      <ProjectPageHeader
        title="人工确认"
        description="逐张确认机器标注 · Y/N 快捷键 · ← → 翻页"
        eyebrow="Quality assurance"
      />

      {actionError && <p className="operations-alert operations-alert--danger">{actionError}</p>}
      {reviewDoneBanner !== null && (
        <p className="operations-alert operations-alert--success">
          机器预审完成 {reviewDoneBanner} 张，请继续逐张确认
        </p>
      )}

      <div className="review-toolbar">
        {REVIEW_FILTERS.map((f) => {
          const count =
            f.value === "pending" ? pendingCount :
            f.value === "rejected" ? rejectedCount :
            f.value === "confirmed" ? confirmedCount : null;
          return (
            <button
              key={f.value}
              type="button"
              className={filter === f.value ? "review-filter review-filter--active" : "review-filter"}
              onClick={() => switchFilter(f.value)}
            >
              {f.label}{count != null && count > 0 ? ` (${count})` : ""}
            </button>
          );
        })}
        {frames.length > 0 && (
          <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--lk-muted)" }}>
            {idx + 1} / {pageTotal}
          </span>
        )}
        <button type="button" className="review-auto-button" onClick={() => setShowAutoReview((v) => !v)}>
          机器预审
        </button>
      </div>

      {showAutoReview && (
        <Panel>
          <TaskProgress
            label="审查进度"
            progress={activeTask?.progress ?? 0}
            total={activeTask?.total ?? 0}
            onStop={running ? stopReview : undefined}
            stopping={stopping}
          />
          {!running && (
            <button type="button" className="btn-secondary" style={{ marginTop: 8 }} disabled={reviewable === 0} onClick={startAutoReview}>
              开始自动审查
            </button>
          )}
        </Panel>
      )}

      {frames.length === 0 ? (
        <Panel>
          <EmptyState
            title={`「${activeFilterMeta?.label}」暂无图片`}
            description={filter === "pending" && confirmedCount > 0 ? "可以尝试查看已确认或开始训练" : undefined}
            action={
              filter === "pending" && confirmedCount > 0 ? (
                <Link href={`/projects/${id}/train`} className="btn-primary">开始训练</Link>
              ) : undefined
            }
          />
        </Panel>
      ) : (
        <>
          <div className={`review-canvas-wrap review-canvas-wrap--${project.task_type}`}>
            <div className="review-canvas">
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
                />
              )}
            </div>
            <aside className="review-side">
              {current && (
                <>
                  <span className="project-section-kicker">Current frame</span>
                  <h2>{current.filename}</h2>
                  <span className="review-side__status">
                    <i aria-hidden="true" />
                    {FRAME_STATUS_SIMPLE[current.status] ?? current.status}
                  </span>
                  {current.review_note && (
                    <p className="review-side__note">{current.review_note}</p>
                  )}
                  <dl className="review-side__stats">
                    <div><dt>当前队列</dt><dd>{frames.length}</dd></div>
                    <div><dt>已确认</dt><dd>{confirmedCount}</dd></div>
                    <div><dt>已驳回</dt><dd>{rejectedCount}</dd></div>
                  </dl>
                  <div className="review-shortcuts">
                    <span>快捷操作</span>
                    <div><kbd>Y</kbd>确认 <kbd>N</kbd>驳回 <kbd>0</kbd>无目标</div>
                    <div><kbd>Del</kbd>删框 <kbd>←</kbd><kbd>→</kbd>翻页</div>
                  </div>
                </>
              )}
            </aside>
          </div>
          <div className="review-filmstrip">
            {frames.slice(Math.max(0, idx - 50), Math.min(frames.length, idx + 51)).map((f, offset) => {
              const i = Math.max(0, idx - 50) + offset;
              return (
              <Thumb
                key={f.id}
                src={api.frameImageUrl(id!, f.id, true)}
                alt={f.filename}
                label={FRAME_STATUS_SIMPLE[f.status]}
                selected={i === idx}
                onClick={() => goFrame(i)}
              />
              );
            })}
            {loadingNext && <span className="review-filmstrip__loading">加载下一页…</span>}
          </div>
        </>
      )}

      {filter === "rejected" && rejectedCount > 0 && (
        <Panel>
          <h2 style={{ margin: "0 0 8px", fontSize: 14 }}>驳回修正</h2>
          <SegmentedControl
            options={[
              { value: "yolo" as const, label: "YOLO" },
              { value: "llm" as const, label: "LLM" },
            ]}
            value={relabelMode}
            onChange={setRelabelMode}
          />
          <div style={{ marginTop: 12 }}>
            {relabelMode === "yolo" ? (
              <YoloLabelPanel projectId={id!} frameStats={frameStats} fixedOnlyStatus="human_wrong" compact onDone={loadFrames} />
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
        </Panel>
      )}
    </div>
  );
}
