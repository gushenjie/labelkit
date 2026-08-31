"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { YoloLabelPanel } from "@/components/YoloLabelPanel";
import { api, Frame, Task } from "@/lib/api";
import { reviewPageUrl, reviewFilterForFrame } from "@/lib/review-nav";
import { FRAME_STATUS_SIMPLE, countPendingReview } from "@/lib/status";
import { ProjectPageHeader } from "@/components/ProjectPageHeader";
import { Panel } from "@/components/ui/Panel";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { TaskProgress } from "@/components/ui/TaskProgress";
import { Thumb } from "@/components/ui/Thumb";
import { useToast } from "@/components/ui/ToastProvider";
import { Icon } from "@/components/Icon";
import { FrameLightbox } from "@/components/FrameLightbox";

const EDITABLE_STATUSES = new Set([
  "llm_labeled",
  "no_target",
  "needs_human",
  "auto_ok",
  "auto_fixed",
  "human_wrong",
]);
const AUTO_TASK_TYPES = new Set(["label", "relabel"]);

type LabelMode = "llm" | "yolo";

const TASK_LABEL: Record<string, string> = {
  label: "LLM 标注",
  relabel: "YOLO 标注",
};

export default function LabelPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { toast } = useToast();
  const [mode, setMode] = useState<LabelMode>("yolo");
  const [estimate, setEstimate] = useState({ frame_count: 0, cost_per_image: 0, estimated_cost: 0 });
  const [tasks, setTasks] = useState<Task[]>([]);
  const [frameStats, setFrameStats] = useState<Record<string, number>>({});
  const [running, setRunning] = useState(false);
  const [recentFrames, setRecentFrames] = useState<Frame[]>([]);
  const [stopping, setStopping] = useState(false);
  const [selected, setSelected] = useState<Frame | null>(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const [actionError, setActionError] = useState("");

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
    api.labelEstimate(id).then(setEstimate);
    api.frameStats(id).then(setFrameStats);
    api.listTasks(id).then((t) => {
      const autoTasks = t.filter((x) => AUTO_TASK_TYPES.has(x.task_type));
      setTasks(autoTasks);
      setRunning(t.some((x) => AUTO_TASK_TYPES.has(x.task_type) && x.status === "running"));
    });
    api.listFrames(id, undefined, "recent", 0).then((frames) => {
      const labeled = frames.filter((f) => f.status !== "unlabeled");
      setRecentFrames(labeled);
      if (labeled.length > 0) {
        setSelected((prev) => (prev && labeled.find((f) => f.id === prev.id) ? prev : labeled[0]));
      }
    });
  };

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, running ? 2000 : 5000);
    return () => clearInterval(t);
  }, [id, running]);

  const startLabel = async () => {
    if (!id) return;
    setActionError("");
    try {
      await api.createTask(id, "label", { only_status: "unlabeled" });
      refresh();
    } catch (e) {
      setActionError(String(e));
    }
  };

  const activeTask = tasks.find((t) => t.status === "running");
  const processedCount =
    (frameStats.llm_labeled ?? 0) +
    (frameStats.auto_ok ?? 0) +
    (frameStats.needs_human ?? 0) +
    (frameStats.no_target ?? 0) +
    (frameStats.auto_fixed ?? 0) +
    (frameStats.human_ok ?? 0);
  const totalCount = frameStats.total ?? 0;

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
    <div className="operations-page label-page">
      <ProjectPageHeader
        title="自动标注"
        description={
          pendingReviewCount > 0
            ? `未标注 ${unlabeledCount} 张 · ${pendingReviewCount} 张待人工复查`
            : `未标注 ${unlabeledCount} 张 · 完成后进入人工复查`
        }
        eyebrow="Assisted labeling"
        action={
          pendingReviewCount > 0 ? (
            <button type="button" className="btn-primary" onClick={() => goReview()}>
              进入人工复查
              <span className="label-review-cta__count">{pendingReviewCount}</span>
              <Icon name="chevron-right" size={15} />
            </button>
          ) : undefined
        }
      />

      <section className="label-command">
        <div className="label-command__metric">
          <span><Icon name="image" size={17} /></span>
          <div><strong>{totalCount}</strong><small>项目素材</small></div>
        </div>
        <div className={unlabeledCount > 0 ? "label-command__metric label-command__metric--attention" : "label-command__metric"}>
          <span><Icon name="sparkles" size={17} /></span>
          <div><strong>{unlabeledCount}</strong><small>等待标注</small></div>
        </div>
        <div className="label-command__metric">
          <span><Icon name="check" size={17} /></span>
          <div><strong>{processedCount}</strong><small>已有结果</small></div>
        </div>
        <div className="label-command__mode">
          <span>标注引擎</span>
          <SegmentedControl
            options={[
              { value: "yolo" as const, label: "YOLO .pt" },
              { value: "llm" as const, label: "LLM 大模型" },
            ]}
            value={mode}
            onChange={setMode}
            disabled={running}
          />
        </div>
      </section>

      {actionError && <p className="operations-alert operations-alert--danger">{actionError}</p>}

      {activeTask && (
        <Panel className="label-live-task">
          <TaskProgress
            label={TASK_LABEL[activeTask.task_type] ?? "标注进度"}
            progress={activeTask.progress}
            total={activeTask.total}
            onStop={stopLabel}
            stopping={stopping}
          />
        </Panel>
      )}

      {mode === "llm" ? (
        <Panel className="label-engine-panel">
          <div className="label-engine-panel__head">
            <span><Icon name="sparkles" size={20} /></span>
            <div>
              <span className="project-section-kicker">Vision language model</span>
              <h2>LLM 大模型标注</h2>
              <p>根据项目类别和提示词理解画面，并生成初始标注。</p>
            </div>
          </div>
          <div className="label-estimate">
            <div><span>待处理</span><strong>{estimate.frame_count} 张</strong></div>
            <div><span>单张成本</span><strong>¥{estimate.cost_per_image}</strong></div>
            <div><span>预估费用</span><strong>¥{estimate.estimated_cost}</strong></div>
          </div>
          <button className="btn-primary" disabled={running || estimate.frame_count === 0} onClick={startLabel}>
            {running && activeTask?.task_type === "label" ? "LLM 标注进行中…" : "开始 LLM 标注"}
          </button>
        </Panel>
      ) : (
        <Panel className="label-engine-panel">
          <YoloLabelPanel projectId={id!} frameStats={frameStats} fixedOnlyStatus="unlabeled" hideProgress onDone={refresh} />
        </Panel>
      )}

      {recentFrames.length > 0 && (
        <Panel className="label-results">
          <div className="label-results__head">
            <div>
              <span className="project-section-kicker">Recent output</span>
              <h2>最近标注结果</h2>
            </div>
            <span>{recentFrames.length} 张预览 · 单击查看大图 · 双击进入复查</span>
            {pendingReviewCount > 0 && (
              <button type="button" className="btn-primary label-results__review-btn" onClick={() => goReview()}>
                进入人工复查
                <span className="label-review-cta__count">{pendingReviewCount}</span>
              </button>
            )}
          </div>
          {pendingReviewCount > 0 && (
            <p className="label-results__hint">
              当前有 {pendingReviewCount} 张待确认，建议在「人工复查」中逐张核对标注框是否准确。
            </p>
          )}
          <div className="label-results__grid">
            {recentFrames.map((f, frameIndex) => (
              <Thumb
                key={f.id}
                src={api.frameImageUrl(id!, f.id, true)}
                alt={f.filename}
                label={FRAME_STATUS_SIMPLE[f.status]}
                selected={selected?.id === f.id}
                onClick={() => {
                  setSelected(f);
                  setLightboxIndex(frameIndex);
                  setLightboxOpen(true);
                }}
                onDoubleClick={() => goReview(f)}
              />
            ))}
          </div>
        </Panel>
      )}
      <FrameLightbox
        open={lightboxOpen}
        frames={recentFrames}
        index={lightboxIndex}
        projectId={id!}
        onClose={() => setLightboxOpen(false)}
        onIndexChange={(nextIndex) => {
          setLightboxIndex(nextIndex);
          const frame = recentFrames[nextIndex];
          if (frame) setSelected(frame);
        }}
        onReview={(frame) => {
          setLightboxOpen(false);
          goReview(frame);
        }}
      />
    </div>
  );
}
