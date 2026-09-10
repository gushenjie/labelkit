"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Icon } from "@/components/Icon";
import { ProjectPageHeader } from "@/components/ProjectPageHeader";
import { LoadingScreen } from "@/components/ui/LoadingScreen";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/ToastProvider";
import { api, MaterialBatch, MaterialFramePage, MaterialInventory, Project } from "@/lib/api";
import { requestProjectStatsRefresh } from "@/lib/project-live";

const ORIGIN_LABELS: Record<string, string> = {
  video: "视频",
  image_upload: "图片上传",
  public_dataset: "公开数据",
  dataset_import: "数据集导入",
  derived: "派生素材",
  legacy: "历史素材",
};

const STATUS_LABELS: Record<string, string> = {
  processing: "处理中",
  action_required: "需要处理",
  ready: "已就绪",
  failed: "失败",
  archived: "已归档",
};

const ACTION_LABELS: Record<string, string> = {
  extract: "开始抽帧",
  continue_import: "继续导入",
  review: "完成抽检",
  label: "补充标注",
  retry: "重试",
  archive: "归档",
  restore: "恢复",
};

const DEFAULT_EXTRACT_PARAMS = {
  target_fps: 1,
  max_frames: 0,
  threshold: 8,
  auto_dedup: true,
  split: "train",
};

type UploadPhase = "uploading" | "processing" | "success" | "error";

type UploadFeedback = {
  names: string[];
  totalBytes: number;
  progress: number;
  phase: UploadPhase;
  containsZip: boolean;
  uploaded?: number;
  error?: string;
};

function formatFileSize(bytes: number) {
  if (bytes < 1024 ** 2) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function batchAnnotationState(batch: MaterialBatch) {
  const unlabeled = batch.frame_status_counts?.unlabeled ?? 0;
  const needsReview =
    (batch.frame_status_counts?.llm_labeled ?? 0) +
    (batch.frame_status_counts?.needs_human ?? 0) +
    (batch.frame_status_counts?.auto_fixed ?? 0) +
    (batch.frame_status_counts?.human_wrong ?? 0);
  if (batch.next_action === "review") {
    const samples = Number(batch.metadata.review_sample_count ?? 0);
    const detail = [samples > 0 ? `${samples.toLocaleString("zh-CN")} 张抽检样本` : "公开标注待确认"];
    if (unlabeled > 0) detail.push(`另有 ${unlabeled} 张待预标注`);
    return { label: "待完成抽检", detail: detail.join(" · "), tone: "action_required" };
  }
  if (batch.status === "ready" && unlabeled > 0) {
    return { label: "待预标注", detail: `${unlabeled.toLocaleString("zh-CN")} 张未标注`, tone: "action_required" };
  }
  if (batch.status === "ready" && needsReview > 0) {
    return { label: "待复核", detail: `${needsReview.toLocaleString("zh-CN")} 张待确认`, tone: "action_required" };
  }
  if (batch.status === "ready") {
    return { label: "标注已就绪", detail: "可纳入训练", tone: "ready" };
  }
  return { label: STATUS_LABELS[batch.status], detail: "", tone: batch.status };
}

function BatchPreviews({ projectId, batch }: { projectId: string; batch: MaterialBatch }) {
  const previewLimit = 6;
  const previews = batch.preview_frame_ids.slice(0, previewLimit);
  return (
    <div className="material-ledger__previews" aria-label={`${batch.title} 预览`}>
      {previews.map((frameId) => (
        <img key={frameId} src={api.frameImageUrl(projectId, frameId, false, { maxEdge: 240 })} alt="" />
      ))}
      {Array.from({ length: Math.max(0, previewLimit - previews.length) }).map((_, index) => (
        <span key={`empty-${index}`} className="material-ledger__preview-empty">
          <Icon name={batch.origin === "video" ? "video" : "image"} size={15} />
        </span>
      ))}
    </div>
  );
}

export function MaterialInventoryPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const confirm = useConfirm();
  const { toast } = useToast();
  const videoInput = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const frameLoadSentinel = useRef<HTMLDivElement>(null);
  const frameLoadInFlight = useRef(false);
  const frameRequestToken = useRef(0);
  const uploadFiles = useRef<File[]>([]);
  const uploadDismissTimer = useRef<number | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [inventory, setInventory] = useState<MaterialInventory | null>(null);
  const [frameStats, setFrameStats] = useState<Record<string, number>>({});
  const [origin, setOrigin] = useState("");
  const [status, setStatus] = useState("");
  const [query, setQuery] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [selected, setSelected] = useState<MaterialBatch | null>(null);
  const [framePage, setFramePage] = useState<MaterialFramePage | null>(null);
  const [framePageLoading, setFramePageLoading] = useState(false);
  const [framePageError, setFramePageError] = useState<string | null>(null);
  const [uploadFeedback, setUploadFeedback] = useState<UploadFeedback | null>(null);
  const highlight = searchParams.get("highlight");

  useEffect(() => () => {
    if (uploadDismissTimer.current) window.clearTimeout(uploadDismissTimer.current);
  }, []);

  const refresh = async () => {
    if (!id) return;
    const [nextInventory, stats] = await Promise.all([
      api.listMaterialBatches(id, { includeArchived, origin, status, query }),
      api.frameStats(id),
    ]);
    setInventory(nextInventory);
    setFrameStats(stats);
    if (selected) {
      setSelected(nextInventory.items.find((item) => item.id === selected.id) ?? null);
    }
  };

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    Promise.all([api.getProject(id).then(setProject), refresh()])
      .catch((error) => toast({ type: "error", message: `素材总账加载失败：${error}` }))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (!id || loading) return;
    const timer = window.setTimeout(() => {
      refresh().catch((error) => toast({ type: "error", message: `筛选失败：${error}` }));
    }, 180);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, origin, status, query, includeArchived]);

  useEffect(() => {
    if (!highlight || !inventory) return;
    const match = inventory.items.find((item) => item.id === highlight);
    if (match) setSelected(match);
  }, [highlight, inventory]);

  useEffect(() => {
    if (!selected || !id) {
      frameRequestToken.current += 1;
      frameLoadInFlight.current = false;
      setFramePage(null);
      setFramePageLoading(false);
      setFramePageError(null);
      return;
    }
    const requestToken = ++frameRequestToken.current;
    frameLoadInFlight.current = true;
    setFramePage(null);
    setFramePageLoading(true);
    setFramePageError(null);
    api.listMaterialBatchFrames(id, selected.id)
      .then((page) => {
        if (frameRequestToken.current === requestToken) setFramePage(page);
      })
      .catch((error) => {
        if (frameRequestToken.current !== requestToken) return;
        setFramePage({ items: [], total: selected.frame_count, offset: 0, limit: 40 });
        setFramePageError(String(error));
        toast({ type: "error", message: `批次详情加载失败：${error}` });
      })
      .finally(() => {
        if (frameRequestToken.current !== requestToken) return;
        frameLoadInFlight.current = false;
        setFramePageLoading(false);
      });
  }, [id, selected?.id, toast]);

  const loadNextFramePage = useCallback(async () => {
    if (!id || !selected || !framePage || frameLoadInFlight.current) return;
    if (framePage.items.length >= framePage.total) return;
    const requestToken = frameRequestToken.current;
    const batchId = selected.id;
    const offset = framePage.items.length;
    frameLoadInFlight.current = true;
    setFramePageLoading(true);
    setFramePageError(null);
    try {
      const page = await api.listMaterialBatchFrames(id, batchId, offset);
      if (frameRequestToken.current !== requestToken) return;
      const existingIds = new Set(framePage.items.map((item) => item.id));
      const additions = page.items.filter((item) => !existingIds.has(item.id));
      if (additions.length === 0 && offset < page.total) {
        throw new Error("服务端未返回下一页素材");
      }
      setFramePage((current) => {
        if (!current) return page;
        return { ...page, offset: 0, items: [...current.items, ...additions] };
      });
    } catch (error) {
      if (frameRequestToken.current !== requestToken) return;
      setFramePageError(String(error));
    } finally {
      if (frameRequestToken.current === requestToken) {
        frameLoadInFlight.current = false;
        setFramePageLoading(false);
      }
    }
  }, [framePage, id, selected]);

  useEffect(() => {
    const root = drawerRef.current;
    const sentinel = frameLoadSentinel.current;
    if (!root || !sentinel || framePageError) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadNextFramePage();
      },
      { root, rootMargin: "240px 0px", threshold: 0.01 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [framePage?.items.length, framePage?.total, framePageError, loadNextFramePage]);

  const totalFrames = inventory?.summary.usable_frame_count ?? 0;
  const pendingBatches = inventory?.summary.pending_batch_count ?? 0;
  const intakeBlockingBatches = inventory?.summary.intake_blocking_batch_count ?? 0;
  const publicReviewBatches = inventory?.summary.review_batch_count ?? 0;
  const publicReviewSamples = inventory?.summary.review_sample_count ?? 0;
  const firstReviewImportId = inventory?.summary.first_review_import_id ?? null;
  const unlabeledFrames = frameStats.unlabeled ?? 0;
  const reviewFrames =
    (frameStats.llm_labeled ?? 0) +
    (frameStats.needs_human ?? 0) +
    (frameStats.auto_fixed ?? 0) +
    (frameStats.human_wrong ?? 0);

  const nextStep = useMemo(() => {
    if (totalFrames === 0) return { label: "标注处理", disabled: true, hint: "请先添加可用图片" };
    if (intakeBlockingBatches > 0) return { label: `处理 ${intakeBlockingBatches} 个接入问题`, action: "pending" };
    if (unlabeledFrames > 0) return { label: `标注处理 ${unlabeledFrames} 张`, href: `/projects/${id}/label` };
    if (publicReviewBatches > 0 && firstReviewImportId) {
      return { label: `完成公开数据抽检`, href: `/projects/${id}/review?filter=sample&publicImport=${firstReviewImportId}` };
    }
    if (reviewFrames > 0) return { label: "进入复核", href: `/projects/${id}/review` };
    return { label: "训练或导出", href: `/projects/${id}/train` };
  }, [firstReviewImportId, id, intakeBlockingBatches, publicReviewBatches, reviewFrames, totalFrames, unlabeledFrames]);

  const showParallelWork = intakeBlockingBatches === 0 && (unlabeledFrames > 0 || publicReviewBatches > 0);

  const runBatchAction = async (batch: MaterialBatch) => {
    if (!id || !batch.next_action) return;
    const action = batch.next_action;
    if (action === "continue_import" || action === "retry") {
      router.push(`/projects/${id}/materials/public`);
      return;
    }
    if (action === "review") {
      const importId = String(batch.metadata.public_import_id ?? "");
      router.push(`/projects/${id}/review?filter=sample&publicImport=${importId}`);
      return;
    }
    if (action === "label") {
      router.push(`/projects/${id}/label`);
      return;
    }
    if (action === "archive") {
      const accepted = await confirm({
        title: "归档素材批次",
        message: `归档「${batch.title}」后，它不会参与当前统计、标注或新训练。归档不会释放磁盘空间，也不会修改已有数据版本。`,
        confirmLabel: "确认归档",
        danger: true,
      });
      if (!accepted) return;
    }
    setBusyId(batch.id);
    try {
      if (action === "extract") {
        await api.createTask(id, "extract", {
          video_ids: [String(batch.metadata.video_id)],
          ...DEFAULT_EXTRACT_PARAMS,
        });
        toast({ type: "success", message: "抽帧任务已启动" });
      } else if (action === "archive") {
        await api.archiveMaterialBatch(id, batch.id);
        toast({ type: "success", message: "批次已归档，文件仍保留" });
      } else if (action === "restore") {
        await api.restoreMaterialBatch(id, batch.id);
        toast({ type: "success", message: "批次已恢复" });
      }
      await refresh();
      requestProjectStatsRefresh(id);
    } catch (error) {
      toast({ type: "error", message: `${ACTION_LABELS[action] ?? "操作"}失败：${error}` });
    } finally {
      setBusyId(null);
    }
  };

  const uploadVideos = async (files: File[]) => {
    if (!id || files.length === 0) return;
    setBusyId("upload");
    try {
      await Promise.all(files.map((file) => api.uploadVideo(id, file)));
      toast({ type: "success", message: `已上传 ${files.length} 个视频，已形成 ${files.length} 个批次` });
      await refresh();
    } catch (error) {
      toast({ type: "error", message: `视频上传失败：${error}` });
    } finally {
      setBusyId(null);
      if (videoInput.current) videoInput.current.value = "";
    }
  };

  const uploadImages = async (files: File[]) => {
    if (!id || files.length === 0) return;
    if (uploadDismissTimer.current) window.clearTimeout(uploadDismissTimer.current);
    uploadFiles.current = files;
    const baseFeedback = {
      names: files.map((file) => file.name),
      totalBytes: files.reduce((sum, file) => sum + file.size, 0),
      containsZip: files.some((file) => file.name.toLowerCase().endsWith(".zip")),
    };
    setUploadFeedback({ ...baseFeedback, progress: 0, phase: "uploading" });
    setBusyId("upload");
    try {
      const result = await api.uploadImagesWithProgress(id, files, (progress) => {
        setUploadFeedback((current) => current ? {
          ...current,
          progress,
          phase: progress >= 100 ? "processing" : "uploading",
        } : current);
      });
      setUploadFeedback({ ...baseFeedback, progress: 100, phase: "success", uploaded: result.uploaded });
      toast({ type: "success", message: `已上传 ${result.uploaded} 张图片，已形成 1 个批次` });
      requestProjectStatsRefresh(id);
      try {
        await refresh();
      } catch (refreshError) {
        toast({ type: "error", message: `素材已上传，但总账刷新失败：${refreshError}` });
      }
      uploadDismissTimer.current = window.setTimeout(() => setUploadFeedback(null), 5000);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      setUploadFeedback({
        ...baseFeedback,
        progress: 0,
        phase: "error",
        error: errorMessage,
      });
      toast({ type: "error", message: `图片上传失败：${errorMessage}` });
    } finally {
      setBusyId(null);
      if (imageInput.current) imageInput.current.value = "";
    }
  };

  if (loading || !inventory) return <LoadingScreen message="正在汇总项目素材…" />;

  return (
    <div className="material-ledger">
      <ProjectPageHeader
        title="素材总账"
        eyebrow="Material Inventory"
        description="统一管理视频、图片上传、公开数据、已有数据集和派生素材。"
        showContext
        action={
          nextStep.href ? (
            <button className="btn btn-primary" onClick={() => router.push(nextStep.href!)}>
              下一步 · {nextStep.label}<Icon name="arrow-right" size={15} />
            </button>
          ) : (
            <button
              className="btn btn-primary"
              disabled={nextStep.disabled}
              title={nextStep.hint}
              onClick={() => document.querySelector("[data-material-blocking='true']")?.scrollIntoView({ behavior: "smooth", block: "center" })}
            >
              {nextStep.label}
            </button>
          )
        }
        meta={
          <div className="material-ledger__stats">
            <span><small>有效素材图片</small><strong>{totalFrames.toLocaleString("zh-CN")}</strong></span>
            <span><small>活动批次</small><strong>{inventory.summary.active_batch_count}</strong></span>
            <span className={pendingBatches ? "is-warning" : ""}><small>待处理批次</small><strong>{pendingBatches}</strong></span>
          </div>
        }
      />

      <section className="material-ledger__surface">
        <div className="material-ledger__toolbar">
          <label className="material-ledger__search">
            <Icon name="search" size={15} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索批次名称" />
          </label>
          <select value={origin} onChange={(event) => setOrigin(event.target.value)} aria-label="按来源筛选">
            <option value="">全部来源</option>
            {Object.entries(ORIGIN_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="按状态筛选">
            <option value="">全部状态</option>
            {Object.entries(STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <label className="material-ledger__archive-toggle">
            <input type="checkbox" checked={includeArchived} onChange={(event) => setIncludeArchived(event.target.checked)} />
            显示归档
          </label>
          <div className="material-ledger__add">
            <button className="btn btn-primary" onClick={() => setAddOpen((value) => !value)} disabled={busyId === "upload"}>
              {busyId === "upload" ? <span className="material-upload__button-spinner" aria-hidden="true" /> : <Icon name="plus" size={15} />}
              {busyId === "upload" ? "素材处理中" : "添加素材"}
            </button>
            {addOpen && (
              <div className="material-ledger__add-menu">
                <button onClick={() => { setAddOpen(false); videoInput.current?.click(); }}><Icon name="video" size={16} /><span>上传视频<small>每个视频形成一个批次</small></span></button>
                <button onClick={() => { setAddOpen(false); imageInput.current?.click(); }}><Icon name="image" size={16} /><span>上传图片或 ZIP<small>本次上传形成一个批次</small></span></button>
                <button onClick={() => router.push(`/projects/${id}/materials/public`)}><Icon name="database" size={16} /><span>从公开数据导入<small>检索并完成许可确认</small></span></button>
              </div>
            )}
          </div>
        </div>

        {uploadFeedback && (
          <div className={`material-upload material-upload--${uploadFeedback.phase}`} role="status" aria-live="polite">
            <span className="material-upload__icon" aria-hidden="true">
              {uploadFeedback.phase === "success" ? <Icon name="check" size={17} /> : uploadFeedback.phase === "error" ? <Icon name="audit" size={17} /> : <Icon name="archive" size={17} />}
            </span>
            <div className="material-upload__copy">
              <strong>
                {uploadFeedback.phase === "uploading" && `正在上传 ${uploadFeedback.names.length} 个文件`}
                {uploadFeedback.phase === "processing" && (uploadFeedback.containsZip ? "正在解压、校验并写入素材" : "正在校验并写入素材")}
                {uploadFeedback.phase === "success" && `已导入 ${uploadFeedback.uploaded ?? 0} 张图片`}
                {uploadFeedback.phase === "error" && "素材上传失败"}
              </strong>
              <span title={uploadFeedback.names.join("、")}>
                {uploadFeedback.names.length === 1 ? uploadFeedback.names[0] : `${uploadFeedback.names[0]} 等 ${uploadFeedback.names.length} 个文件`}
                {` · ${formatFileSize(uploadFeedback.totalBytes)}`}
                {uploadFeedback.phase === "success" && " · 已形成 1 个素材批次"}
                {uploadFeedback.phase === "error" && ` · ${uploadFeedback.error}`}
              </span>
            </div>
            {(uploadFeedback.phase === "uploading" || uploadFeedback.phase === "processing") && (
              <div className="material-upload__progress-wrap">
                <div
                  className={`material-upload__progress${uploadFeedback.phase === "processing" ? " is-processing" : ""}`}
                  role="progressbar"
                  aria-label={uploadFeedback.phase === "processing" ? "素材处理进度" : "文件上传进度"}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={uploadFeedback.progress}
                >
                  <i style={{ width: `${uploadFeedback.progress}%` }} />
                </div>
                <small>{uploadFeedback.phase === "processing" ? "上传完成，处理中" : `${uploadFeedback.progress}%`}</small>
              </div>
            )}
            {uploadFeedback.phase === "error" && (
              <button type="button" className="btn btn-secondary" onClick={() => void uploadImages(uploadFiles.current)}>重试</button>
            )}
            {(uploadFeedback.phase === "success" || uploadFeedback.phase === "error") && (
              <button type="button" className="material-upload__close" aria-label="关闭上传状态" onClick={() => setUploadFeedback(null)}><Icon name="x" size={14} /></button>
            )}
          </div>
        )}

        {showParallelWork && (
          <div className="material-next-work" aria-label="接下来要完成的工作">
            <div className="material-next-work__copy">
              <small>接下来</small>
              <strong>{unlabeledFrames > 0 && publicReviewBatches > 0 ? "两项工作可以并行完成" : "完成剩余的数据准备工作"}</strong>
              <span>
                {unlabeledFrames > 0 && publicReviewBatches > 0
                  ? "本地素材先生成初始标注，公开数据保留已有标注并完成抽检；两项可并行，待标注复核通过后再训练。"
                  : unlabeledFrames > 0
                    ? "只处理尚未标注的图片，不会覆盖公开数据已有标注。"
                    : "公开数据已有标注，只需完成抽检确认，不需要重复预标注。"}
              </span>
            </div>
            <div className="material-next-work__actions">
              {unlabeledFrames > 0 && (
                <button type="button" className="material-next-work__action is-primary" onClick={() => router.push(`/projects/${id}/label`)}>
                  <span><Icon name="sparkles" size={16} /></span>
                  <span><strong>标注处理</strong><small>{unlabeledFrames.toLocaleString("zh-CN")} 张未标注 · AI 或人工</small></span>
                  <Icon name="arrow-right" size={14} />
                </button>
              )}
              {publicReviewBatches > 0 && firstReviewImportId && (
                <button type="button" className="material-next-work__action" onClick={() => router.push(`/projects/${id}/review?filter=sample&publicImport=${firstReviewImportId}`)}>
                  <span><Icon name="audit" size={16} /></span>
                  <span><strong>确认公开数据抽检</strong><small>{publicReviewSamples.toLocaleString("zh-CN")} 张样本 · 保留已有标注</small></span>
                  <Icon name="arrow-right" size={14} />
                </button>
              )}
            </div>
          </div>
        )}

        <div className="material-ledger__table-head" aria-hidden="true">
          <span>批次</span><span>来源</span><span>素材预览</span><span>帧数</span><span>状态</span><span>操作</span>
        </div>
        <div className="material-ledger__rows">
          {inventory.items.map((batch) => (
            <article
              key={batch.id}
              id={`material-${batch.id}`}
              data-material-pending={batch.status !== "ready" && batch.status !== "archived" ? "true" : undefined}
              data-material-blocking={batch.status === "processing" || batch.status === "failed" || ["extract", "continue_import", "retry"].includes(batch.next_action ?? "") ? "true" : undefined}
              className={`material-ledger__row ${highlight === batch.id ? "is-highlighted" : ""}`}
              onClick={() => setSelected(batch)}
            >
              <div className="material-ledger__identity">
                <span className={`material-ledger__origin-icon origin-${batch.origin}`}><Icon name={batch.origin === "video" ? "video" : batch.origin === "public_dataset" ? "database" : "image"} size={17} /></span>
                <span><strong>{batch.title}</strong><small>{formatDate(batch.created_at)}</small></span>
              </div>
              <span className="material-ledger__origin">{ORIGIN_LABELS[batch.origin] ?? batch.origin}</span>
              <BatchPreviews projectId={id} batch={batch} />
              <span className="material-ledger__count"><strong>{batch.frame_count.toLocaleString("zh-CN")}</strong><small>张</small></span>
              {(() => {
                const annotationState = batchAnnotationState(batch);
                return (
                  <span className="material-ledger__status-stack">
                    <span className={`material-ledger__status status-${annotationState.tone}`}><i />{annotationState.label}</span>
                    {annotationState.detail && <small>{annotationState.detail}</small>}
                  </span>
                );
              })()}
              <div className="material-ledger__action">
                {batch.next_action ? (
                  <button
                    className={batch.next_action === "archive" ? "btn btn-ghost" : "btn btn-secondary"}
                    disabled={busyId === batch.id}
                    onClick={(event) => { event.stopPropagation(); void runBatchAction(batch); }}
                  >
                    {busyId === batch.id ? "处理中…" : ACTION_LABELS[batch.next_action] ?? "处理"}
                  </button>
                ) : <span className="material-ledger__muted">等待任务完成</span>}
              </div>
            </article>
          ))}
          {inventory.items.length === 0 && (
            <div className="material-ledger__empty">
              <span><Icon name="folder" size={24} /></span>
              <strong>没有符合筛选条件的素材批次</strong>
              <p>可调整筛选，或通过“添加素材”汇入视频、图片和公开数据。</p>
            </div>
          )}
        </div>
      </section>

      <input ref={videoInput} hidden type="file" accept="video/*" multiple onChange={(event) => void uploadVideos(Array.from(event.target.files ?? []))} />
      <input ref={imageInput} hidden type="file" accept="image/*,.zip,application/zip" multiple onChange={(event) => void uploadImages(Array.from(event.target.files ?? []))} />

      {selected && (
        <div className="material-drawer-backdrop" onMouseDown={() => setSelected(null)}>
          <aside ref={drawerRef} className="material-drawer" onMouseDown={(event) => event.stopPropagation()} aria-label="素材批次详情">
            <header>
              <div><small>{ORIGIN_LABELS[selected.origin]}</small><h2>{selected.title}</h2></div>
              <button aria-label="关闭详情" onClick={() => setSelected(null)}><Icon name="x" size={18} /></button>
            </header>
            <div className="material-drawer__summary">
              <span><small>批次状态</small><strong>{STATUS_LABELS[selected.status]}</strong></span>
              <span><small>素材帧数</small><strong>{selected.frame_count.toLocaleString("zh-CN")}</strong></span>
              <span><small>待标注/复核</small><strong>{selected.pending_frame_count.toLocaleString("zh-CN")}</strong></span>
            </div>
            <div className="material-drawer__meta">
              <h3>来源信息</h3>
              <dl>
                <div><dt>批次 ID</dt><dd>{selected.id}</dd></div>
                {selected.metadata.provider ? <div><dt>数据提供方</dt><dd>{String(selected.metadata.provider)}</dd></div> : null}
                {selected.metadata.license_name ? <div><dt>许可</dt><dd>{String(selected.metadata.license_name)}</dd></div> : null}
                <div><dt>创建时间</dt><dd>{new Date(selected.created_at).toLocaleString("zh-CN")}</dd></div>
              </dl>
            </div>
            <div className="material-drawer__frames">
              <h3>批次帧 <small>{framePage?.total ?? selected.frame_count}</small></h3>
              <div className="material-drawer__frames-grid">
                {framePage?.items.map((frame) => (
                  <figure key={frame.id}>
                    <img src={api.frameImageUrl(id, frame.id, false, { maxEdge: 360 })} alt={frame.filename} />
                    <figcaption title={frame.filename}>{frame.filename}</figcaption>
                  </figure>
                ))}
              </div>
              {!framePage && framePageLoading && (
                <div className="material-drawer__load-state" aria-live="polite">
                  <span className="material-drawer__spinner" aria-hidden="true" />正在加载素材…
                </div>
              )}
              {framePage && framePage.items.length < framePage.total && !framePageError && (
                <div ref={frameLoadSentinel} className="material-drawer__load-state" aria-live="polite">
                  {framePageLoading && <><span className="material-drawer__spinner" aria-hidden="true" />正在加载更多素材…</>}
                </div>
              )}
              {framePageError && (
                <div className="material-drawer__load-state is-error" role="alert">
                  <span>加载失败</span>
                  <button type="button" className="btn btn-secondary" onClick={() => void loadNextFramePage()}>重试</button>
                </div>
              )}
              {framePage && framePage.total > 0 && framePage.items.length >= framePage.total && (
                <p className="material-drawer__load-state is-complete">已加载全部 {framePage.total.toLocaleString("zh-CN")} 张素材</p>
              )}
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
