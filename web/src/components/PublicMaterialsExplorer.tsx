"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import {
  api,
  Project,
  PublicDatasetCandidate,
  PublicDatasetImport,
  PublicDatasetProvider,
  Task,
  Video,
} from "@/lib/api";
import { Icon } from "@/components/Icon";
import { ProjectPageHeader } from "@/components/ProjectPageHeader";
import { TaskProgress } from "@/components/ui/TaskProgress";
import { LoadingScreen } from "@/components/ui/LoadingScreen";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/ToastProvider";
import {
  matchesProjectLiveEvent,
  PROJECT_STATS_REFRESH_EVENT,
  requestProjectStatsRefresh,
} from "@/lib/project-live";
import { formatDatasetFormat, formatPublicImportState, allSourceLabelsIgnored, classMappingSelectValue, candidatePreviewUrl, formatCandidateClasses, formatCompactCount } from "@/lib/publicDatasetLabels";

type UploadItem = {
  name: string;
  pct: number;
  done: boolean;
};

type MaterialSource = "local" | "public";

function isZipFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return (
    name.endsWith(".zip") ||
    file.type === "application/zip" ||
    file.type === "application/x-zip-compressed"
  );
}

function isImageUploadFile(file: File): boolean {
  return file.type.startsWith("image/") || isZipFile(file);
}

const DISCOVERY_EXAMPLES = ["厂区入侵检测", "烟雾识别", "反光衣检测", "鸟窝检测"];
const numberFormatter = new Intl.NumberFormat("zh-CN");
const ROBOFLOW_URL_RE = /^https:\/\/(?:universe|app)\.roboflow\.com\//i;
/** 抽帧与去重默认策略，与后端 task_worker 默认值保持一致 */
const DEFAULT_EXTRACT_PARAMS = {
  target_fps: 1,
  max_frames: 0,
  threshold: 8,
  auto_dedup: true,
  split: "train" as const,
};

function formatBytes(bytes: number | null | undefined) {
  if (bytes == null) return "大小未知";
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function publicImportCardStatus(state: string): string | null {
  if (state === "discarded") return null;
  if (["review", "review_expanded"].includes(state)) return "待复核";
  if (state === "training") return "训练中";
  if (state === "completed") return "已导入";
  if (["fetching", "fetched", "publishing", "needs_label"].includes(state)) return "导入中";
  return null;
}

const PUBLIC_DIALOG_STATES = ["fetching", "fetched", "publishing", "needs_label"] as const;
const PUBLIC_REVIEW_STATES = ["review", "review_expanded", "full_review_required"] as const;

function isPublicDialogState(state: string): boolean {
  return (PUBLIC_DIALOG_STATES as readonly string[]).includes(state);
}

function isPublicReviewState(state: string): boolean {
  return (PUBLIC_REVIEW_STATES as readonly string[]).includes(state);
}

/** 下载失败/中断：不算已导入资产，列表不展示，也不阻塞重新下载 */
function isPublicImportFailed(state: string): boolean {
  return state === "fetch_failed" || state === "fetch_interrupted";
}

function publicImportImageCount(item: PublicDatasetImport): number {
  const raw = Number(item.quality_report?.image_count ?? 0);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

function publicImportSampleCount(item: PublicDatasetImport): number {
  return item.review_frame_ids?.length ?? 0;
}

function publicImportTone(state: string): "progress" | "review" | "done" | "danger" | "muted" {
  if (["fetch_failed", "fetch_interrupted", "publish_interrupted"].includes(state)) return "danger";
  if (isPublicReviewState(state)) return "review";
  if (isPublicDialogState(state) || state === "training") return "progress";
  if (["published", "completed"].includes(state)) return "done";
  return "muted";
}

/** 列表态标签：短、可扫，不与操作文案撞车 */
function inventoryStateLabel(state: string): string {
  if (isPublicReviewState(state)) return "待复核";
  if (state === "needs_label") return "待补标";
  if (isPublicDialogState(state)) return "处理中";
  if (state === "training") return "训练中";
  if (["published", "completed"].includes(state)) return "已就绪";
  return formatPublicImportState(state);
}

function sortPublicImports(items: PublicDatasetImport[]): PublicDatasetImport[] {
  const rank = (state: string) => {
    if (isPublicDialogState(state)) return 0;
    if (isPublicReviewState(state)) return 1;
    if (state === "needs_label") return 2;
    if (["fetch_failed", "fetch_interrupted", "publish_interrupted"].includes(state)) return 3;
    if (state === "training") return 4;
    return 5;
  };
  return [...items].sort((a, b) => {
    const diff = rank(a.state) - rank(b.state);
    if (diff !== 0) return diff;
    return (a.title || a.source_ref).localeCompare(b.title || b.source_ref, "zh-CN");
  });
}

/** 同一来源指纹只保留优先级最高的一条，避免同名重复卡 */
function dedupePublicImports(items: PublicDatasetImport[]): PublicDatasetImport[] {
  const ordered = sortPublicImports(items);
  const seen = new Set<string>();
  const result: PublicDatasetImport[] = [];
  for (const item of ordered) {
    const key = item.license_fingerprint || item.id;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function PublicImportInventory({
  projectId,
  imports,
  sampleReviewPending,
}: {
  projectId: string;
  imports: PublicDatasetImport[];
  sampleReviewPending: number;
}) {
  const visible = dedupePublicImports(imports.filter((item) => !isPublicImportFailed(item.state)));
  if (visible.length === 0) return null;
  const totalImages = visible.reduce((sum, item) => sum + publicImportImageCount(item), 0);

  return (
    <section className="materials-public-inventory" aria-label="已导入公开数据集">
      <header className="materials-public-inventory__head">
        <div>
          <h3>已导入</h3>
          <p>
            {visible.length} 批
            {totalImages > 0 ? ` · ${numberFormatter.format(totalImages)} 张` : ""}
            {sampleReviewPending > 0 ? ` · ${numberFormatter.format(sampleReviewPending)} 张待复核` : ""}
          </p>
        </div>
        {sampleReviewPending > 0 && (
          <Link href={`/projects/${projectId}/review?filter=sample`} className="btn-secondary">
            去复核
          </Link>
        )}
      </header>
      <ul className="materials-public-inventory__list">
        {visible.map((item) => {
          const imageCount = publicImportImageCount(item);
          const sampleCount = publicImportSampleCount(item);
          const tone = publicImportTone(item.state);
          const title = item.title || item.source_ref;
          const meta = [
            item.source_version ? `v${item.source_version}` : "",
            imageCount > 0 ? `${numberFormatter.format(imageCount)} 张` : "",
            sampleCount > 0 && isPublicReviewState(item.state)
              ? `抽 ${numberFormatter.format(sampleCount)}`
              : "",
          ]
            .filter(Boolean)
            .join(" · ");

          const actionHref = isPublicReviewState(item.state)
            ? `/projects/${projectId}/review?filter=sample`
            : item.state === "needs_label"
              ? `/projects/${projectId}/label`
              : null;

          const body = (
            <>
              <div className="materials-public-inventory__title-row">
                <strong title={title}>{title}</strong>
                <em>{inventoryStateLabel(item.state)}</em>
              </div>
              {meta ? <p>{meta}</p> : null}
            </>
          );

          return (
            <li key={item.id}>
              {actionHref ? (
                <Link
                  href={actionHref}
                  className={`materials-public-inventory__item is-${tone} is-actionable`}
                  title={isPublicReviewState(item.state) ? "进入抽样复核" : "进入素材标注"}
                >
                  {body}
                  <span className="materials-public-inventory__chevron" aria-hidden="true">
                    <Icon name="chevron-right" size={14} />
                  </span>
                </Link>
              ) : (
                <div className={`materials-public-inventory__item is-${tone}`}>
                  {body}
                  {item.source_url ? (
                    <a
                      href={item.source_url}
                      target="_blank"
                      rel="noreferrer"
                      className="materials-public-inventory__link materials-public-inventory__link--muted"
                      onClick={(event) => event.stopPropagation()}
                    >
                      来源
                    </a>
                  ) : null}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function upsertPublicImport(list: PublicDatasetImport[], next: PublicDatasetImport): PublicDatasetImport[] {
  const index = list.findIndex((item) => item.id === next.id);
  if (index < 0) return [...list, next];
  return list.map((item) => (item.id === next.id ? next : item));
}

function qualityReportCounts(report: Record<string, unknown>, key: string): Record<string, number> {
  const raw = report[key];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>)
      .map(([name, value]) => [name, Number(value)] as [string, number])
      .filter(([, value]) => Number.isFinite(value) && value > 0),
  );
}

const SPLIT_LABELS: Record<string, string> = {
  train: "训练",
  val: "验证",
  test: "测试",
};

function DistributionBars({
  items,
  emptyText,
}: {
  items: Array<{ key: string; label: string; count: number }>;
  emptyText: string;
}) {
  const total = items.reduce((sum, item) => sum + item.count, 0);
  if (total <= 0) {
    return <p className="materials-public-dist__empty">{emptyText}</p>;
  }
  return (
    <ul className="materials-public-dist__bars">
      {items.map((item) => (
        <li key={item.key}>
          <span>
            {item.label}
            <strong>{numberFormatter.format(item.count)}</strong>
          </span>
          <i style={{ width: `${Math.max(4, Math.round((item.count / total) * 100))}%` }} />
        </li>
      ))}
    </ul>
  );
}

function qualityReportMessages(report: Record<string, unknown>, key: "blocking" | "warnings"): string[] {
  const items = report[key];
  if (!Array.isArray(items)) return [];
  return items.map((item) => String(item)).filter(Boolean);
}

function explainImportIssue(message: string, kind: "blocking" | "warning"): string {
  if (message.includes("自动去重")) {
    return message;
  }
  if (message.includes("跨 split")) {
    return kind === "blocking"
      ? `${message}。同一图片不能同时出现在训练集和验证集，这份数据无法直接导入，请换其他数据集。`
      : `${message}。建议换一份划分更干净的数据集，或确认接受风险后再导入。`;
  }
  if (message.includes("空标签")) {
    return `${message}。部分图片没有标注框，导入后可能需要补标或复核。`;
  }
  if (message.includes("极小框")) {
    return `${message}。部分标注框过小，导入后建议重点抽样复核。`;
  }
  return message;
}

function MaterialsUploadDialog({
  uploads,
  uploading,
  onClose,
}: {
  uploads: UploadItem[];
  uploading: boolean;
  onClose: () => void;
}) {
  const finishedCount = uploads.filter((item) => item.done).length;
  const allDone = uploads.length > 0 && uploads.every((item) => item.done);

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !uploading) onClose();
      }}
    >
      <div className="materials-upload-dialog" role="dialog" aria-modal="true" aria-labelledby="materials-upload-title">
        <header className="materials-upload-dialog__head">
          <div>
            <h2 id="materials-upload-title">上传进度</h2>
            <p>{uploading ? "正在上传，请勿关闭页面" : allDone ? "全部上传完成" : "部分文件上传失败"}</p>
          </div>
          <span className="materials-upload-dialog__count">{finishedCount} / {uploads.length}</span>
        </header>
        <div className="materials-upload-dialog__body">
          {uploads.map((item) => (
            <div key={item.name} className="materials-upload-dialog__item">
              <div className="materials-upload-dialog__item-head">
                <span title={item.name}>{item.name}</span>
                <strong>{item.done ? "完成" : uploading ? `${item.pct}%` : "失败"}</strong>
              </div>
              <div className="materials-upload-dialog__bar">
                <div
                  className={`materials-upload-dialog__bar-fill ${item.done ? "is-done" : ""}`}
                  style={{ width: `${item.done ? 100 : item.pct}%` }}
                />
              </div>
            </div>
          ))}
        </div>
        <footer className="materials-upload-dialog__footer">
          <span>{uploading ? "上传完成后将自动关闭" : allDone ? "即将自动关闭…" : "可关闭窗口后重试失败文件"}</span>
          <button type="button" className="btn-secondary" disabled={uploading} onClick={onClose}>
            关闭
          </button>
        </footer>
      </div>
    </div>
  );
}

type PublicDatasetImportDialogProps = {
  publicImport: PublicDatasetImport;
  project: Project | null;
  publicBusy: boolean;
  fetchProgress: { progress: number; total: number } | null;
  classMapping: Record<string, number | null>;
  setClassMapping: Dispatch<SetStateAction<Record<string, number | null>>>;
  publishAnnotationCount: number;
  publishClassDistribution: Record<string, number>;
  publishLabelsFullyIgnored: boolean;
  publishBlockingIssues: string[];
  publishWarnings: string[];
  canDiscard: boolean;
  canPublish: boolean;
  onDiscard: () => void;
  onPublish: () => void;
};

function PublicDatasetImportDialog({
  publicImport,
  project,
  publicBusy,
  fetchProgress,
  classMapping,
  setClassMapping,
  publishAnnotationCount,
  publishClassDistribution,
  publishLabelsFullyIgnored,
  publishBlockingIssues,
  publishWarnings,
  canDiscard,
  canPublish,
  onDiscard,
  onPublish,
}: PublicDatasetImportDialogProps) {
  const title = publicImport.title || "公开数据集";
  const expectedBytes = publicImport.expected_download_bytes ?? fetchProgress?.total ?? 0;
  const downloadedBytes = fetchProgress?.progress ?? publicImport.actual_download_bytes ?? 0;
  const hasByteProgress = expectedBytes > 0;
  const downloadPercent = hasByteProgress
    ? Math.min(100, Math.round((downloadedBytes / expectedBytes) * 100))
    : null;
  const downloadFinished = hasByteProgress && downloadedBytes >= expectedBytes;
  const subtitle = publicImport.state === "fetching"
    ? downloadFinished
      ? "下载完成，分析中…"
      : "下载中…"
    : publicImport.state === "fetched"
      ? `${String(publicImport.quality_report.image_count ?? 0)} 张 · ${publishAnnotationCount} 条标注${publicImport.detected_format ? ` · ${formatDatasetFormat(publicImport.detected_format)}` : ""}`
      : publicImport.state === "needs_label"
        ? "导入完成，部分图片仍待预标注"
        : "导入进行中";

  const handleBackdropClose = () => {
    if (!canDiscard || publicBusy) return;
    onDiscard();
  };

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) handleBackdropClose();
      }}
    >
      <div
        className="materials-public-import-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="public-import-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="materials-public-import-dialog__head">
          <div>
            <h2 id="public-import-dialog-title">{title}</h2>
            <p>{subtitle}</p>
          </div>
          {canDiscard && (
            <button
              type="button"
              className="modal-close-button"
              aria-label="关闭并放弃导入"
              disabled={publicBusy}
              onClick={onDiscard}
            >
              <Icon name="x" size={18} />
            </button>
          )}
        </header>

        <div className="materials-public-import-dialog__body lk-scrollbar">
          {publicImport.state === "fetching" && (
            <div className="materials-public-import-dialog__loading">
              <PublicImportWaitVisual analyzing={downloadFinished} />
              <strong>{downloadFinished ? "正在分析" : "正在下载"}</strong>
              {hasByteProgress ? (
                <div className="materials-public-import-dialog__progress" aria-label="下载进度">
                  <div className="materials-public-import-dialog__progress-head">
                    <span>{downloadFinished ? "下载完成" : "下载进度"}</span>
                    <strong>{downloadPercent}%</strong>
                  </div>
                  <div className="materials-public-import-dialog__progress-bar">
                    <div
                      className={`materials-public-import-dialog__progress-fill${downloadFinished ? " is-done" : " is-active"}`}
                      style={{ width: `${downloadPercent ?? 0}%` }}
                    />
                  </div>
                  <span className="materials-public-import-dialog__progress-meta">
                    {formatBytes(downloadedBytes)} / {formatBytes(expectedBytes)}
                  </span>
                </div>
              ) : (
                <div
                  className="materials-public-import-dialog__progress-bar materials-public-import-dialog__progress-bar--indeterminate"
                  aria-hidden="true"
                >
                  <div className="materials-public-import-dialog__progress-fill is-indeterminate" />
                </div>
              )}
              <span>{downloadFinished ? "完成后确认标签" : "请稍候"}</span>
            </div>
          )}

          {publicImport.state === "fetched" && (
            <section className="materials-public-mapping materials-public-mapping--dialog">
              <header className="materials-public-mapping__head">
                <div>
                  <h3>确认标签导入</h3>
                  <p>数据集里的检测标签需要对应到你项目的类别。名称一致时一般保持默认即可。</p>
                </div>
              </header>

              {(() => {
                const splitCounts = qualityReportCounts(publicImport.quality_report, "split_distribution");
                const splitItems = (["train", "val", "test"] as const)
                  .filter((split) => (splitCounts[split] ?? 0) > 0)
                  .map((split) => ({
                    key: split,
                    label: SPLIT_LABELS[split],
                    count: splitCounts[split],
                  }));
                const classItems = publicImport.source_classes
                  .map((sourceClass) => ({
                    key: String(sourceClass.class_id),
                    label: sourceClass.name,
                    count: publishClassDistribution[String(sourceClass.class_id)] ?? 0,
                  }))
                  .filter((item) => item.count > 0);
                const hasVal = (splitCounts.val ?? 0) > 0;
                if (splitItems.length === 0 && classItems.length === 0) return null;
                return (
                  <div className="materials-public-dist">
                    {splitItems.length > 0 && (
                      <div>
                        <strong>图片划分</strong>
                        <DistributionBars items={splitItems} emptyText="未识别到划分信息" />
                        {!hasVal && (
                          <p className="materials-public-dist__note">没有验证集，导入后训练时会由项目自行划分。</p>
                        )}
                      </div>
                    )}
                    {classItems.length > 0 && (
                      <div>
                        <strong>标签数量</strong>
                        <DistributionBars items={classItems} emptyText="暂无标注" />
                      </div>
                    )}
                  </div>
                );
              })()}

              {publishBlockingIssues.length > 0 && (
                <div className="materials-public-mapping__issues materials-public-mapping__issues--danger">
                  <strong>无法导入的原因</strong>
                  <ul>
                    {publishBlockingIssues.map((issue) => (
                      <li key={issue}>{explainImportIssue(issue, "blocking")}</li>
                    ))}
                  </ul>
                </div>
              )}

              {publishWarnings.length > 0 && (
                <div className="materials-public-mapping__issues materials-public-mapping__issues--warning">
                  <strong>质量提示（可继续导入）</strong>
                  <ul>
                    {publishWarnings.map((issue) => (
                      <li key={issue}>{explainImportIssue(issue, "warning")}</li>
                    ))}
                  </ul>
                </div>
              )}

              {publishLabelsFullyIgnored && (
                <div className="materials-public-mapping__warning">
                  不能全部选「不导入」。请至少保留一个标签导入到项目类别。
                </div>
              )}

              <div className="materials-public-mapping__columns" aria-hidden="true">
                <span>数据集标签</span>
                <span>导入为</span>
              </div>

              <div className="materials-public-mapping__list">
                {publicImport.source_classes.map((sourceClass) => {
                  const labelCount = publishClassDistribution[String(sourceClass.class_id)] ?? 0;
                  const mappedClassId = classMapping[String(sourceClass.class_id)];
                  const mappedName = mappedClassId == null
                    ? null
                    : project?.categories.find((category) => category.class_id === mappedClassId)?.name;
                  return (
                    <div key={sourceClass.class_id} className="materials-public-mapping__row">
                      <div className="materials-public-mapping__source">
                        <strong>{sourceClass.name}</strong>
                        <span>{labelCount > 0 ? `${numberFormatter.format(labelCount)} 条标注` : "暂无标注"}</span>
                      </div>
                      <select
                        className="input materials-public-mapping__select"
                        aria-label={`将 ${sourceClass.name} 导入为`}
                        value={classMappingSelectValue(classMapping, sourceClass.class_id)}
                        onChange={(event) => setClassMapping((previous) => ({
                          ...previous,
                          [String(sourceClass.class_id)]: event.target.value === "ignore" ? null : Number(event.target.value),
                        }))}
                      >
                        <option value="ignore">不导入</option>
                        {project?.categories.map((category) => (
                          <option key={category.class_id} value={String(category.class_id)}>
                            {category.name}
                          </option>
                        ))}
                      </select>
                      {mappedName && labelCount > 0 && (
                        <p className="materials-public-mapping__hint">
                          {sourceClass.name} 的 {numberFormatter.format(labelCount)} 条标注将导入为「{mappedName}」
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>

              <p className="materials-public-mapping__footer">
                导入后，图片和标注会加入当前项目，可在「本地素材」中查看。
              </p>
            </section>
          )}

          {["publishing", "needs_label"].includes(publicImport.state) && (
            <div className="materials-public-import__status">
              <Icon name="sparkles" size={16} className="text-[#10A88F]" />
              <div className="materials-public-import__status-copy">
                <strong>
                  {publicImport.state === "needs_label"
                    ? "已写入项目，可继续补标"
                    : "正在写入图片与标注"}
                </strong>
                <span>
                  {publicImport.state === "needs_label"
                    ? "无标注图片可在「素材标注」中选择 AI 或人工处理，有标注图片可去做抽样复核。"
                    : "请稍候，完成后可在左侧查看该数据集，并进入抽样复核。"}
                </span>
              </div>
            </div>
          )}
        </div>

        <footer className="materials-public-import-dialog__footer">
          {canDiscard && (
            <button type="button" className="btn-secondary" disabled={publicBusy} onClick={onDiscard}>
              放弃
            </button>
          )}
          {publicImport.state === "fetched" && (
            <button
              type="button"
              className="btn-primary"
              disabled={publicBusy || !canPublish}
              onClick={onPublish}
            >
              导入到项目
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

type PublicFetchBootstrap = {
  title: string;
  sourceVersion: string;
  phase: "preparing" | "failed";
  error?: string;
};

const PREPARE_STEPS = ["确认版本信息", "创建下载任务", "就绪开始下载"] as const;

function PublicImportWaitVisual({ analyzing = false }: { analyzing?: boolean }) {
  return (
    <div
      className={`materials-public-import-dialog__wait-visual${analyzing ? " is-analyzing" : ""}`}
      aria-hidden="true"
    >
      <span className="materials-public-import-dialog__orbit" />
      <span className="materials-public-import-dialog__orbit materials-public-import-dialog__orbit--inner" />
      <span className="materials-public-import-dialog__wait-core">
        <Icon name="sparkles" size={28} className="materials-public-import-dialog__wait-icon" />
      </span>
      <span className="materials-public-import-dialog__wait-dots">
        <i />
        <i />
        <i />
      </span>
    </div>
  );
}

function PublicFetchPreparingDialog({
  bootstrap,
  onClose,
}: {
  bootstrap: PublicFetchBootstrap;
  onClose: () => void;
}) {
  const failed = bootstrap.phase === "failed";
  const [activeStep, setActiveStep] = useState(0);

  useEffect(() => {
    if (failed) return;
    setActiveStep(0);
    const timer = window.setInterval(() => {
      setActiveStep((previous) => (previous < PREPARE_STEPS.length - 1 ? previous + 1 : previous));
    }, 1200);
    return () => window.clearInterval(timer);
  }, [failed, bootstrap.title, bootstrap.sourceVersion]);

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (failed && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="materials-public-import-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="public-fetch-preparing-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="materials-public-import-dialog__head">
          <div>
            <h2 id="public-fetch-preparing-title">{bootstrap.title}</h2>
            <p>
              {failed
                ? "创建失败"
                : `v${bootstrap.sourceVersion} · 准备中`}
            </p>
          </div>
          {failed && (
            <button type="button" className="modal-close-button" aria-label="关闭" onClick={onClose}>
              <Icon name="x" size={18} />
            </button>
          )}
        </header>
        <div className="materials-public-import-dialog__body">
          <div className="materials-public-import-dialog__loading">
            {failed ? (
              <Icon name="sparkles" size={36} className="text-[#10A88F]" />
            ) : (
              <PublicImportWaitVisual />
            )}
            <strong>{failed ? "无法开始下载" : "正在创建任务"}</strong>
            {failed ? (
              <span>{bootstrap.error || "请稍后重试"}</span>
            ) : (
              <>
                <ol className="materials-public-import-dialog__steps" aria-live="polite">
                  {PREPARE_STEPS.map((label, index) => {
                    const className = index < activeStep
                      ? "is-done"
                      : index === activeStep
                        ? "is-active"
                        : undefined;
                    return (
                      <li key={label} className={className}>
                        {label}
                      </li>
                    );
                  })}
                </ol>
                <span>请稍候</span>
              </>
            )}
          </div>
        </div>
        <footer className={`materials-public-import-dialog__footer${failed ? "" : " materials-public-import-dialog__footer--hint"}`}>
          <span>
            {failed
              ? "可关闭后重新选择"
              : "完成后自动开始下载"}
          </span>
          {failed && (
            <button type="button" className="btn-secondary" onClick={onClose}>
              关闭
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

function PublicDatasetCandidatePreview({ candidate }: { candidate: PublicDatasetCandidate }) {
  const initialPreview = candidatePreviewUrl(candidate);
  const [previewUrl, setPreviewUrl] = useState<string | null>(initialPreview);
  const [loading, setLoading] = useState(!initialPreview && candidate.provider === "roboflow");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setPreviewUrl(initialPreview);
    setFailed(false);
    if (initialPreview || candidate.provider !== "roboflow") {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api.roboflowPreview(candidate.source_ref, candidate.source_version)
      .then((data) => {
        if (cancelled) return;
        const url = candidatePreviewUrl({
          annotation_thumbnail: data.annotation_thumbnail,
          thumbnail: data.thumbnail,
        });
        if (url) setPreviewUrl(url);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    candidate.provider,
    candidate.source_ref,
    candidate.source_version,
    candidate.thumbnail,
    candidate.annotation_thumbnail,
    initialPreview,
  ]);

  const placeholderLabel = candidate.classes[0] || candidate.title || "数据集";

  return (
    <div className="w-full h-full relative">
      {previewUrl && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={previewUrl}
          alt=""
          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : (
        <div className="w-full h-full flex flex-col items-center justify-center bg-[#F4FAF8] text-[#10A88F]/50 gap-2 p-4 text-center">
          <Icon name="image" size={26} />
          <span className="text-[10px] font-medium truncate max-w-full text-[#17343A]/60">{placeholderLabel}</span>
          {loading && <span className="text-[10px] text-[#10A88F]/70 animate-pulse">加载预览…</span>}
        </div>
      )}
    </div>
  );
}

function PublicDatasetCandidateCard({
  candidate,
  recommended,
  selected,
  importStatus,
  onSelect,
}: {
  candidate: PublicDatasetCandidate;
  recommended: boolean;
  selected: boolean;
  importStatus: string | null;
  onSelect: () => void;
}) {
  const classPreview = formatCandidateClasses(candidate.classes ?? [], 3);
  const hasDownloadSize = candidate.download_bytes != null && candidate.download_bytes > 0;
  const hasStars = candidate.stars != null && candidate.stars > 0;
  const showFooter = hasDownloadSize || hasStars;

  return (
    <article
      className={`cursor-pointer rounded-xl border p-4 transition-all flex flex-col ${
        selected 
          ? 'bg-white border-[#10A88F] shadow-[0_8px_32px_rgba(16,168,143,0.12)] ring-1 ring-[#10A88F] scale-[1.02] z-10' 
          : 'bg-white/80 border-white hover:border-[#CFF4EC] hover:bg-white shadow-[0_4px_24px_rgba(16,168,143,0.04)] hover:shadow-[0_8px_32px_rgba(16,168,143,0.08)]'
      }`}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onSelect();
      }}
    >
      <div className="w-full aspect-video rounded-lg overflow-hidden bg-[#F4FAF8] border border-[#CFF4EC]/50 mb-3 shrink-0 relative group shadow-sm">
        <PublicDatasetCandidatePreview candidate={candidate} />
        <div className="absolute top-2 left-2 flex gap-1 z-20">
          <span className="text-[10px] font-bold bg-black/60 backdrop-blur-md text-white px-1.5 py-0.5 rounded shadow-sm flex items-center gap-1">
            <Icon name="image" size={10} /> {candidate.image_count ? `${numberFormatter.format(candidate.image_count)}` : "未知"}
          </span>
          {recommended && !importStatus && (
            <span className="text-[10px] font-bold bg-[#10A88F]/90 backdrop-blur-md text-white px-1.5 py-0.5 rounded shadow-sm">
              推荐
            </span>
          )}
        </div>
        {importStatus && (
          <div className="absolute top-2 right-2 z-20">
            <span
              className={`public-dataset-card__import-badge public-dataset-card__import-badge--${
                importStatus === "待复核" ? "review" : importStatus === "导入中" ? "progress" : "done"
              }`}
            >
              <Icon name={importStatus === "待复核" ? "clock" : "check"} size={10} />
              {importStatus}
            </span>
          </div>
        )}
        <div className="absolute bottom-2 right-2 z-20">
          <span className="text-[10px] font-bold bg-black/60 backdrop-blur-md text-white px-1.5 py-0.5 rounded shadow-sm">v{candidate.source_version}</span>
        </div>
      </div>

      <h4 className="text-sm font-bold text-[#075F5A] mb-2 truncate group-hover:text-[#10A88F] transition-colors" title={candidate.title}>{candidate.title}</h4>
                                        
                                        <div className="text-xs text-[#17343A]/70 mb-2 flex-1 flex flex-col gap-1.5">
                                          <div className="flex items-start gap-1.5"><Icon name="check" size={12} className="text-[#10A88F] mt-0.5 shrink-0" /><span className="line-clamp-2 leading-relaxed">{candidate.recommendation_reason?.replace(/^最推荐\s*·\s*/, "") || candidate.description || "暂无相关描述信息"}</span></div>
                                        </div>

                                        {classPreview.visible.length > 0 && (
                                          <div className="flex flex-wrap gap-1 mt-auto mb-3" aria-label="数据集类别">
                                            {classPreview.visible.map((className) => <span key={className} className="px-1.5 py-0.5 bg-[#f0f4f3] text-[#17343A]/60 rounded text-[10px] truncate max-w-[80px] border border-[#e4e7ec]/50 shadow-sm">{className}</span>)}
                                            {classPreview.overflow > 0 && <span className="px-1.5 py-0.5 bg-[#f0f4f3] text-[#17343A]/60 rounded text-[10px] border border-[#e4e7ec]/50 shadow-sm">+{classPreview.overflow}</span>}
                                          </div>
                                        )}

                                        {showFooter && (
                                          <div className="flex items-center gap-2 pt-3 border-t border-[#e4e7ec] mt-auto">
                                            {hasDownloadSize && (
                                              <div className="flex items-center gap-1.5 text-[11px] font-bold text-[#17343A]/60">
                                                <Icon name="database" size={12} className="text-[#10A88F]/70" /> {formatBytes(candidate.download_bytes)}
                                              </div>
                                            )}
                                            {hasStars && (
                                              <div className="flex items-center gap-1 text-[11px] font-bold text-[#17343A]/60" title="收藏">
                                                <Icon name="star" size={12} className="text-[#10A88F]/70" /> {formatCompactCount(candidate.stars!)}
                                              </div>
                                            )}
                                          </div>
                                        )}
    </article>
  );
}

export default function PublicMaterialsExplorer() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [project, setProject] = useState<Project | null>(null);
  const [videos, setVideos] = useState<Video[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [running, setRunning] = useState(false);
  const [frameStats, setFrameStats] = useState<Record<string, number>>({});
  const [selectedVideoIds, setSelectedVideoIds] = useState<Set<string>>(new Set());
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [discoveryIntent, setDiscoveryIntent] = useState("");
  const [showDiscoveryPlan, setShowDiscoveryPlan] = useState(false);
  const [providers, setProviders] = useState<PublicDatasetProvider[]>([]);
  const [candidates, setCandidates] = useState<PublicDatasetCandidate[]>([]);
  const [discoveryErrors, setDiscoveryErrors] = useState<Record<string, string>>({});
  const [discovering, setDiscovering] = useState(false);
  const [selectedCandidate, setSelectedCandidate] = useState<PublicDatasetCandidate | null>(null);
  const [publicImports, setPublicImports] = useState<PublicDatasetImport[]>([]);
  const [classMapping, setClassMapping] = useState<Record<string, number | null>>({});
  const [mappingInitializedFor, setMappingInitializedFor] = useState<string | null>(null);
  const [autoLabel, setAutoLabel] = useState(false);
  const [costConfirmed, setCostConfirmed] = useState(false);
  const [trainingParams, setTrainingParams] = useState({ epochs: 80, imgsz: 640, batch: 8, device: "auto" });
  const [publicBusy, setPublicBusy] = useState(false);
  const [fetchBootstrap, setFetchBootstrap] = useState<PublicFetchBootstrap | null>(null);
  const [fetchTaskProgress, setFetchTaskProgress] = useState<{ progress: number; total: number } | null>(null);
  const [sourceMode, setSourceMode] = useState<MaterialSource>("public");
  const [deletingVideoId, setDeletingVideoId] = useState<string | null>(null);
  const videoRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLInputElement>(null);
  const selectionInitializedRef = useRef(false);
  const prevPublicImportStatesRef = useRef<Record<string, string>>({});

  const dialogImport = useMemo(
    () => publicImports.find((item) => isPublicDialogState(item.state)) ?? null,
    [publicImports],
  );
  const selectedCandidateImport = useMemo(
    () => (selectedCandidate
      ? publicImports.find(
          (item) =>
            item.license_fingerprint === selectedCandidate.license_fingerprint
            && !isPublicImportFailed(item.state),
        ) ?? null
      : null),
    [publicImports, selectedCandidate],
  );

  const refresh = () => {
    if (!id) return;
    api.listVideos(id).then((items) => {
      setVideos(items);
      setSelectedVideoIds((previous) => {
        const valid = new Set(items.map((item) => item.id));
        const next = new Set([...previous].filter((videoId) => valid.has(videoId)));
        // 仅首次进入页面时默认勾选未提取视频；轮询刷新不再覆盖用户手动取消的勾选
        if (!selectionInitializedRef.current) {
          selectionInitializedRef.current = true;
          items.forEach((video) => {
            if ((video.extracted_count ?? 0) === 0) next.add(video.id);
          });
        }
        return next;
      });
    });
    api.frameStats(id).then(setFrameStats);
    api.listTasks(id).then((items) => {
      setTasks(items);
      setRunning(
        items.some(
          (item) =>
            item.status === "running" && ["extract", "dedup"].includes(item.task_type),
        ),
      );
    });
  };

  useEffect(() => {
    if (!id) return;
    selectionInitializedRef.current = false;
    api.getProject(id).then(setProject);
    api.publicDatasetProviders().then(setProviders).catch(() => setProviders([]));
    api.listPublicDatasetImports(id).then((imports) => {
      const active = imports.filter((item) => item.state !== "discarded");
      setPublicImports(active);
      if (active.length > 0) {
        setSourceMode("public");
        if (active.some((item) => isPublicDialogState(item.state))) {
          setShowDiscoveryPlan(true);
        }
      }
    }).catch(() => undefined);
    refresh();
  }, [id]);

  useEffect(() => {
    if (!id || !running) return;
    const timer = window.setInterval(refresh, 2000);
    return () => window.clearInterval(timer);
  }, [id, running]);

  useEffect(() => {
    if (!id) return;
    const onRefresh = (event: Event) => {
      if (!matchesProjectLiveEvent(event, id)) return;
      api.frameStats(id).then(setFrameStats).catch(() => undefined);
      api.listTasks(id).then((items) => {
        setTasks(items);
        setRunning(
          items.some(
            (item) =>
              item.status === "running" && ["extract", "dedup"].includes(item.task_type),
          ),
        );
      }).catch(() => undefined);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") onRefresh(new Event(PROJECT_STATS_REFRESH_EVENT));
    };
    window.addEventListener(PROJECT_STATS_REFRESH_EVENT, onRefresh);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener(PROJECT_STATS_REFRESH_EVENT, onRefresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [id]);

  useEffect(() => {
    if (!id || sourceMode !== "public") return;
    let active = true;
    const poll = () => {
      api.listPublicDatasetImports(id).then((imports) => {
        if (!active) return;
        setPublicImports(imports.filter((item) => item.state !== "discarded"));
      }).catch(() => undefined);
    };
    poll();
    const timer = window.setInterval(poll, 2000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [id, sourceMode]);

  useEffect(() => {
    if (dialogImport?.state !== "fetched") {
      return;
    }
    if (mappingInitializedFor === dialogImport.id) return;
    setClassMapping(dialogImport.suggested_mapping);
    setMappingInitializedFor(dialogImport.id);
  }, [dialogImport?.id, dialogImport?.state, dialogImport?.suggested_mapping, mappingInitializedFor]);

  useEffect(() => {
    if (!id) return;
    for (const item of publicImports) {
      const previousState = prevPublicImportStatesRef.current[item.id];
      prevPublicImportStatesRef.current[item.id] = item.state;
      if (previousState === "publishing" && isPublicReviewState(item.state)) {
        const sampleCount = item.review_frame_ids?.length ?? 0;
        toast({
          type: "info",
          message: sampleCount > 0
            ? `「${item.title}」已导入，项目抽样复核新增 ${sampleCount} 张`
            : `「${item.title}」已导入，请前往标注复核`,
        });
        router.push(`/projects/${id}/review?filter=sample&publicImport=${item.id}`);
        break;
      }
    }
  }, [id, publicImports, router, toast]);

  useEffect(() => {
    if (!id || !dialogImport || dialogImport.state !== "fetching" || !dialogImport.fetch_task_id) {
      setFetchTaskProgress(null);
      return;
    }
    let active = true;
    const taskId = dialogImport.fetch_task_id;
    const poll = () => {
      api.getTask(id, taskId).then((task) => {
        if (!active) return;
        setFetchTaskProgress({ progress: task.progress ?? 0, total: task.total ?? 0 });
      }).catch(() => undefined);
    };
    poll();
    const timer = window.setInterval(poll, 800);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [id, dialogImport?.id, dialogImport?.state, dialogImport?.fetch_task_id]);

  const closeUploadDialog = () => {
    if (uploading) return;
    setUploads([]);
  };

  useEffect(() => {
    if (uploading || uploads.length === 0) return;
    if (!uploads.every((item) => item.done)) return;
    const timer = window.setTimeout(() => setUploads([]), 1500);
    return () => window.clearTimeout(timer);
  }, [uploading, uploads]);

  const uploadVideosParallel = async (files: File[]) => {
    if (!id || files.length === 0) return;
    setUploading(true);
    setUploads(files.map((file) => ({ name: file.name, pct: 0, done: false })));
    const newIds: string[] = [];
    await Promise.all(
      files.map(async (file, index) => {
        try {
          const video = await api.uploadVideoWithProgress(id, file, (pct) => {
            setUploads((previous) =>
              previous.map((item, itemIndex) =>
                itemIndex === index ? { ...item, pct } : item,
              ),
            );
          });
          newIds.push(video.id);
          setUploads((previous) =>
            previous.map((item, itemIndex) =>
              itemIndex === index ? { ...item, pct: 100, done: true } : item,
            ),
          );
        } catch (error) {
          toast({ type: "error", message: `${file.name} 上传失败：${error}` });
        }
      }),
    );
    setSelectedVideoIds((previous) => {
      const next = new Set(previous);
      newIds.forEach((videoId) => next.add(videoId));
      return next;
    });
    setUploading(false);
    refresh();
    if (newIds.length > 0) {
      toast({ type: "success", message: `已上传 ${newIds.length} 个视频，可开始提取素材` });
    }
  };

  const uploadImages = async (files: File[]) => {
    const uploadable = files.filter(isImageUploadFile);
    if (uploadable.length === 0 || !id) return;
    setUploading(true);
    setUploads(uploadable.map((file) => ({ name: file.name, pct: 35, done: false })));
    try {
      const result = await api.uploadImages(id, uploadable);
      setUploads(uploadable.map((file) => ({ name: file.name, pct: 100, done: true })));
      refresh();
      toast({ type: "success", message: `已上传 ${result.uploaded} 张图片` });
    } catch (error) {
      toast({ type: "error", message: `图片上传失败：${error}` });
    } finally {
      setUploading(false);
      if (imageRef.current) imageRef.current.value = "";
    }
  };

  const handleDroppedFiles = (files: File[]) => {
    const videoFiles = files.filter((file) => file.type.startsWith("video/"));
    const imageFiles = files.filter(isImageUploadFile);
    if (videoFiles.length > 0) void uploadVideosParallel(videoFiles);
    if (imageFiles.length > 0) void uploadImages(imageFiles);
    if (videoFiles.length === 0 && imageFiles.length === 0) {
      toast({ type: "error", message: "请选择视频、图片或 ZIP 压缩包" });
    }
  };

  const deleteVideo = async (video: Video) => {
    if (!id) return;
    const extracted = video.extracted_count ?? 0;
    const confirmed = await confirm({
      title: "删除视频",
      message:
        extracted > 0
          ? `确定删除「${video.filename}」？将同时删除该视频及已提取的 ${extracted} 张素材，不可恢复。`
          : `确定删除「${video.filename}」？删除后不可恢复。`,
      confirmLabel: "删除",
      danger: true,
    });
    if (!confirmed) return;

    setDeletingVideoId(video.id);
    try {
      const result = await api.deleteVideo(id, video.id);
      setSelectedVideoIds((previous) => {
        const next = new Set(previous);
        next.delete(video.id);
        return next;
      });
      refresh();
      toast({
        type: "success",
        message: result.removed_frames > 0 ? `视频已删除，并清理 ${result.removed_frames} 张关联素材` : "视频已删除",
      });
    } catch (error) {
      toast({ type: "error", message: `删除失败：${error}` });
    } finally {
      setDeletingVideoId(null);
    }
  };

  const startPrepare = async () => {
    if (!id || videos.length === 0) {
      toast({ type: "error", message: "请先上传视频" });
      return;
    }
    const videoIds = [...selectedVideoIds];
    if (videoIds.length === 0) {
      toast({ type: "error", message: "请至少选择一个视频" });
      return;
    }
    try {
      await api.createTask(id, "extract", {
        video_ids: videoIds,
        ...DEFAULT_EXTRACT_PARAMS,
      });
      refresh();
      requestProjectStatsRefresh(id);
      toast({ type: "success", message: "提取任务已启动，进度可在页面上方查看" });
    } catch (error) {
      toast({ type: "error", message: `提取失败：${error}` });
    }
  };

  const kaggleAvailable = providers.some((item) => item.provider === "kaggle" && item.available);
  const roboflowAvailable = providers.some((item) => item.provider === "roboflow" && item.available);
  const keywordDiscoveryAvailable = kaggleAvailable || roboflowAvailable;
  const publicExamples = DISCOVERY_EXAMPLES;

  const buildDiscoveryPlan = async () => {
    if (!discoveryIntent.trim()) {
      toast({
        type: "error",
        message: keywordDiscoveryAvailable
          ? "请先描述希望识别的目标或场景，也可粘贴数据集链接"
          : "公开数据集检索暂不可用，请联系管理员配置",
      });
      return;
    }
    if (!id) return;
    const intent = discoveryIntent.trim();
    const isRoboflowUrl = ROBOFLOW_URL_RE.test(intent);

    if (!isRoboflowUrl && !keywordDiscoveryAvailable) {
      setShowDiscoveryPlan(true);
      setCandidates([]);
      setSelectedCandidate(null);
      setDiscoveryErrors({
        providers: "当前未配置可用的公开数据源凭据",
      });
      toast({ type: "error", message: "公开数据集检索暂不可用，请联系管理员配置" });
      return;
    }

    setDiscovering(true);
    setShowDiscoveryPlan(true);
    setSelectedCandidate(null);
    try {
      const result = await api.discoverPublicDatasets(
        id,
        isRoboflowUrl ? "" : intent,
        isRoboflowUrl ? intent : "",
      );
      setCandidates(result.candidates);
      setDiscoveryErrors(result.errors);
      if (result.candidates.length === 0) {
        const detail = Object.values(result.errors).filter(Boolean).join("；");
        toast({
          type: "error",
          message: detail || "没有找到可验证的数据集候选，请换个检索词试试",
        });
      }
    } catch (error) {
      toast({ type: "error", message: `公开数据检索失败：${error}` });
    } finally {
      setDiscovering(false);
    }
  };

  const startPublicFetch = async () => {
    if (!id || !selectedCandidate) return;
    const confirmed = await confirm({
      title: "确认下载数据集",
      message: `将下载「${selectedCandidate.title}」v${selectedCandidate.source_version} 并开始分析，是否继续？`,
      confirmLabel: "开始下载",
    });
    if (!confirmed) return;
    const candidate = selectedCandidate;
    setFetchBootstrap({
      title: candidate.title,
      sourceVersion: candidate.source_version,
      phase: "preparing",
    });
    setPublicBusy(true);
    try {
      const created = await api.fetchPublicDataset(id, candidate);
      setPublicImports((previous) => upsertPublicImport(previous, created));
      setShowDiscoveryPlan(true);
      setMappingInitializedFor(null);
      setClassMapping({});
      setFetchBootstrap(null);
      toast({ type: "info", message: "已开始下载固定版本并执行安全检查" });
    } catch (error) {
      setFetchBootstrap({
        title: candidate.title,
        sourceVersion: candidate.source_version,
        phase: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      toast({ type: "error", message: `无法开始下载：${error}` });
    } finally {
      setPublicBusy(false);
    }
  };

  const startPublicPublish = async () => {
    if (!id || !dialogImport) return;
    if (dialogImport.source_classes.some((item) => !(String(item.class_id) in classMapping))) {
      toast({ type: "error", message: "请为每个来源类别选择项目类别或忽略" });
      return;
    }
    const annotationCount = Number(dialogImport.quality_report.annotation_count ?? 0);
    if (allSourceLabelsIgnored(classMapping, dialogImport.source_classes, annotationCount)) {
      toast({
        type: "error",
        message: "数据集含有标注，不能全部设为「忽略」。请至少映射一个来源类别到项目类别。",
      });
      return;
    }
    setPublicBusy(true);
    try {
      await api.publishPublicDataset(id, dialogImport.id, {
        class_mapping: classMapping,
        warnings_confirmed: true,
        auto_label: autoLabel,
        cost_confirmed: costConfirmed,
        training_params: trainingParams,
      });
      setPublicImports((previous) => upsertPublicImport(previous, { ...dialogImport, state: "publishing" }));
      toast({ type: "info", message: "正在导入公开数据，可在任务中心查看进度" });
    } catch (error) {
      toast({ type: "error", message: `公开数据导入失败：${error}` });
    } finally {
      setPublicBusy(false);
    }
  };

  const publishAnnotationCount = dialogImport ? Number(dialogImport.quality_report.annotation_count ?? 0) : 0;
  const publishClassDistribution = (dialogImport?.quality_report?.class_distribution ?? {}) as Record<string, number>;
  const publishLabelsFullyIgnored = dialogImport
    ? allSourceLabelsIgnored(classMapping, dialogImport.source_classes, publishAnnotationCount)
    : false;
  const publishBlockingIssues = dialogImport
    ? qualityReportMessages(dialogImport.quality_report, "blocking")
    : [];
  const publishWarnings = dialogImport
    ? qualityReportMessages(dialogImport.quality_report, "warnings")
    : [];
  const canDiscardPublicImport = Boolean(
    dialogImport
    && !dialogImport.dataset_version_id
    && !["fetching", "publishing", "training"].includes(dialogImport.state),
  );
  const canPublishPublicImport = Boolean(
    dialogImport?.state === "fetched"
    && publishBlockingIssues.length === 0
    && !publishLabelsFullyIgnored,
  );
  const showPublicImportDialog = Boolean(dialogImport);
  const sampleReviewPending = frameStats.needs_human ?? 0;
  const canStartPublicFetch = Boolean(
    selectedCandidate
    && !selectedCandidateImport
    && !dialogImport
    && !fetchBootstrap,
  );
  const selectedImportInReview = Boolean(
    selectedCandidateImport && isPublicReviewState(selectedCandidateImport.state),
  );

  const retryPublicFetch = async () => {
    if (!id || !dialogImport?.fetch_task_id) return;
    setPublicBusy(true);
    try {
      await api.retryTask(id, dialogImport.fetch_task_id);
      setPublicImports((previous) => upsertPublicImport(previous, { ...dialogImport, state: "fetching" }));
      toast({ type: "info", message: "已从断点续传下载，请勿关闭后端服务" });
    } catch (error) {
      toast({ type: "error", message: `续传下载失败：${error}` });
      const refreshed = await api.getPublicDatasetImport(id, dialogImport.id).catch(() => null);
      if (refreshed) setPublicImports((previous) => upsertPublicImport(previous, refreshed));
    } finally {
      setPublicBusy(false);
    }
  };

  const discardPublicImport = async () => {
    if (!id || !dialogImport) return;
    const confirmed = await confirm({
      title: "放弃导入",
      message: "确定放弃本次公开数据导入？已下载的临时文件会被清理，不影响项目已有素材。",
      confirmLabel: "放弃",
    });
    if (!confirmed) return;
    setPublicBusy(true);
    try {
      await api.discardPublicDataset(id, dialogImport.id);
      setPublicImports((previous) => previous.filter((item) => item.id !== dialogImport.id));
      if (mappingInitializedFor === dialogImport.id) {
        setMappingInitializedFor(null);
        setClassMapping({});
      }
      toast({ type: "success", message: "已放弃本次导入，可继续选择其他数据集" });
      refresh();
      return true;
    } catch (error) {
      toast({ type: "error", message: `${error}` });
      return false;
    } finally {
      setPublicBusy(false);
    }
  };

  const activeExtract = tasks.find(
    (task) => task.task_type === "extract" && task.status === "running",
  );
  const readyFrames = frameStats.total ?? 0;
  const projectTypeLabel = project?.task_type === "classify" ? "图像分类" : "目标检测";
  const categoryNames = project?.categories.map((category) => category.name).join("、");

  return (
    <div className="materials-workspace materials-workspace--fit materials-page">
      <div className="materials-workspace__glow materials-workspace__glow--left" aria-hidden="true" />
      <div className="materials-workspace__glow materials-workspace__glow--right" aria-hidden="true" />

      <div className="materials-workspace__inner">
        <ProjectPageHeader
          title="公开数据探索"
          eyebrow="Public Dataset Discovery"
          description="检索、评估并导入公开数据；通过复核后会回到项目素材总账。"
          showContext={true}
          action={
            <Link href={`/projects/${id}/materials`} className="btn btn-primary">
              <Icon name="chevron-left" size={15} /> 返回素材总账
            </Link>
          }
          meta={
            <div className="flex flex-wrap gap-3">
              <span className="flex items-center gap-1.5 bg-[#F4FAF8] border border-[#CFF4EC] px-3 py-1.5 rounded-lg text-sm text-[#075F5A] shadow-sm">
                <small className="text-[#17343A]/50 text-xs">{projectTypeLabel}</small>
                <strong>{categoryNames || "尚未定义类别"}</strong>
              </span>
              <span className="flex items-center gap-1.5 bg-white border border-[#e4e7ec] px-3 py-1.5 rounded-lg text-sm text-[#17343A] shadow-sm">
                <Icon name="image" size={14} className="text-[#10A88F]" />
                <strong>{numberFormatter.format(readyFrames)}</strong>
                <small className="text-[#17343A]/50 text-xs">可用帧</small>
              </span>
              <span className="flex items-center gap-1.5 bg-white border border-[#e4e7ec] px-3 py-1.5 rounded-lg text-sm text-[#17343A] shadow-sm">
                <Icon name="video" size={14} className="text-[#10A88F]" />
                <strong>{videos.length}</strong>
                <small className="text-[#17343A]/50 text-xs">个视频</small>
              </span>
            </div>
          }
        />

        {activeExtract && (
          <div className="materials-extract-banner">
            <span className="materials-extract-banner__label">
              <Icon name="clock" size={14} className="materials-extract-banner__icon" />
              正在提取可标注帧
            </span>
            <TaskProgress progress={activeExtract.progress} total={activeExtract.total} label="提取进度" />
          </div>
        )}

        <div className="materials-workspace__main">
          <div className="materials-workspace__toolbar">
            <span className="materials-public-context">导入完成后，批次将统一出现在素材总账中</span>
          </div>

          <div className="materials-workspace__content">
            {sourceMode === "local" && (
              <>
                <div 
                  className={`materials-panel materials-panel--local ${dragOver ? "materials-panel--drag" : ""}`}
                  onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragOver(false);
                    handleDroppedFiles(Array.from(e.dataTransfer.files));
                  }}
                >
                  {dragOver && (
                    <div className="absolute inset-0 z-50 flex items-center justify-center bg-white/50 backdrop-blur-sm">
                      <div className="text-center p-8 bg-white border border-[#CFF4EC] rounded-2xl shadow-xl shadow-[#10A88F]/10">
                        <div className="w-16 h-16 bg-[#F4FAF8] text-[#10A88F] rounded-full flex items-center justify-center mx-auto mb-4">
                          <Icon name="upload" size={32} />
                        </div>
                        <h3 className="text-xl font-bold text-[#075F5A] mb-2">释放鼠标，立即上传</h3>
                      </div>
                    </div>
                  )}

                  <div className="materials-panel__head">
                    <div className="flex items-center gap-3">
                      <h2 className="text-base font-bold text-[#075F5A] flex items-center gap-2">
                        <Icon name="video" size={16} className="text-[#10A88F]" /> 
                        已上传的视频与图片
                      </h2>
                      <span className="text-[10px] font-bold text-[#10A88F] bg-[#10A88F]/10 px-2 py-0.5 rounded uppercase tracking-wider">{videos.length} ITEMS</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-[#e4e7ec] text-[#344054] rounded-lg text-sm font-medium hover:bg-gray-50 transition-colors shadow-sm" onClick={() => videoRef.current?.click()}>
                        <Icon name="video" size={14} /> 选视频
                      </button>
                      <button
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-[#e4e7ec] text-[#344054] rounded-lg text-sm font-medium hover:bg-gray-50 transition-colors shadow-sm"
                        title="支持多选图片或 ZIP 压缩包批量上传"
                        onClick={() => imageRef.current?.click()}
                      >
                        <Icon name="image" size={14} /> 图片/压缩包
                      </button>
                      <div className="w-px h-5 bg-[#e4e7ec] mx-1"></div>
                      <button 
                        className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-bold transition-colors shadow-sm ${selectedVideoIds.size > 0 ? 'bg-[#10A88F] text-white hover:bg-[#078D82] shadow-[#10A88F]/20' : 'bg-gray-100 text-gray-400 cursor-not-allowed'}`}
                        onClick={() => void startPrepare()} 
                        disabled={selectedVideoIds.size === 0 || running || uploading}
                      >
                        <Icon name="play" size={14} /> 开始提取
                      </button>
                    </div>
                  </div>

                  <div className="materials-panel__body materials-panel__body--local">
                    {videos.length === 0 ? (
                      <div className="materials-local-dropzone materials-local-dropzone--fill">
                        <Icon name="upload" size={28} className="text-[#10A88F]/70" />
                        <strong>拖拽文件到这里上传</strong>
                        <span>MP4、MOV、AVI、JPG、PNG、ZIP 等</span>
                      </div>
                    ) : (
                      <div className="bg-white border border-[#f0f4f3] rounded-xl overflow-hidden shadow-sm">
                        <table className="materials-video-table w-full text-left border-collapse">
                              <thead>
                                <tr className="border-b border-[#f0f4f3] bg-[#f4faf8]/50">
                                  <th className="w-12">
                                     <input type="checkbox" className="rounded border-gray-300 text-[#10A88F] focus:ring-[#10A88F]" onChange={() => setSelectedVideoIds(new Set(videos.map(v => v.id)))} />
                                  </th>
                                  <th className="w-[148px]">封面</th>
                                  <th className="materials-video-table__filename">文件名</th>
                                  <th className="w-24">大小</th>
                                  <th className="w-24">时长</th>
                                  <th className="w-24">原片帧</th>
                                  <th className="w-24">已提取</th>
                                  <th className="w-20 text-center">操作</th>
                                </tr>
                              </thead>
                              <tbody>
                                {videos.map((video) => (
                                  <tr key={video.id} className="border-b border-[#f0f4f3] hover:bg-gray-50/50 transition-colors">
                                    <td>
                                      <input
                                        type="checkbox"
                                        className="rounded border-gray-300 text-[#10A88F] focus:ring-[#10A88F]"
                                        checked={selectedVideoIds.has(video.id)}
                                        onChange={() => setSelectedVideoIds(prev => {
                                          const next = new Set(prev);
                                          if (next.has(video.id)) next.delete(video.id); else next.add(video.id);
                                          return next;
                                        })}
                                      />
                                    </td>
                                    <td>
                                      <div className="materials-video-table__thumb">
                                        <img src={api.videoThumbnailUrl(id as string, video.id)} alt="" onError={(e) => { e.currentTarget.style.display = "none"; }} />
                                        <span className="materials-video-table__thumb-icon"><Icon name="video" size={16} /></span>
                                      </div>
                                    </td>
                                    <td className="materials-video-table__filename" title={video.filename}>{video.filename}</td>
                                    <td className="text-[#17343A]/70 text-sm tabular-nums">{formatBytes(video.file_bytes)}</td>
                                    <td className="text-[#17343A]/70 text-sm tabular-nums">{video.duration_sec ? `${video.duration_sec.toFixed(1)}s` : "—"}</td>
                                    <td className="text-[#17343A]/70 text-sm tabular-nums">{video.frame_count ?? "—"}</td>
                                    <td>
                                      {video.extracted_count ? (
                                        <span className="text-[#10A88F] font-bold bg-[#10A88F]/10 px-2 py-0.5 rounded-md text-xs">{video.extracted_count}</span>
                                      ) : <span className="text-gray-400 text-sm">0</span>}
                                    </td>
                                    <td className="text-center">
                                      <button
                                        type="button"
                                        className="materials-video-table__delete"
                                        title="删除视频"
                                        disabled={deletingVideoId === video.id || running || uploading}
                                        onClick={() => void deleteVideo(video)}
                                      >
                                        <Icon name="trash" size={18} />
                                      </button>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}

            {sourceMode === "public" && (
              <div className="materials-public-layout">
                <aside className="materials-public-layout__search">
                  <div className="materials-public-layout__search-card">
                    <div className="materials-public-layout__search-top">
                      <h2 className="text-base font-bold text-[#075F5A] mb-1">公开数据检索</h2>
                      <p className="text-xs text-[#17343A]/70 mb-4">输入你想识别的目标或场景名称</p>

                      <div className="materials-public-search-field">
                        <textarea
                          aria-label="识别需求"
                          className="input materials-public-search-input"
                          rows={2}
                          value={discoveryIntent}
                          placeholder="例如：反光衣检测"
                          onChange={(e) => { setDiscoveryIntent(e.target.value); setShowDiscoveryPlan(false); }}
                        />
                        <button
                          type="button"
                          aria-label="查找公开数据"
                          className="materials-public-search-field__action"
                          disabled={discovering}
                          onClick={buildDiscoveryPlan}
                        >
                          <Icon name="search" size={14} />
                        </button>
                      </div>

                      <div className="flex flex-wrap gap-1.5">
                        {publicExamples.map((ex) => (
                          <button
                            key={ex}
                            type="button"
                            onClick={() => {
                              setDiscoveryIntent(ex);
                              setShowDiscoveryPlan(false);
                            }}
                            className="px-2 py-0.5 bg-white border border-[#e4e7ec] rounded text-[11px] font-medium text-[#17343A]/70 hover:border-[#10A88F] hover:text-[#10A88F] transition-colors"
                          >
                            {ex}
                          </button>
                        ))}
                      </div>
                    </div>

                    {id && publicImports.some((item) => !isPublicImportFailed(item.state)) && (
                      <PublicImportInventory
                        projectId={id}
                        imports={publicImports}
                        sampleReviewPending={sampleReviewPending}
                      />
                    )}
                  </div>
                </aside>

                <section className="materials-panel materials-public-layout__panel">
                   <div className="materials-panel__head">
                     <div className="materials-panel__head-copy">
                       <h2 className="text-base font-bold text-[#075F5A] flex items-center gap-2">
                         <Icon name="database" size={16} className="text-[#10A88F]" /> 
                         {selectedCandidate ? "数据集详情" : showDiscoveryPlan ? "建议搜索词" : discoveryIntent ? "检索结果" : "数据探索"}
                       </h2>
                       {showDiscoveryPlan && !discovering && candidates.length > 0 && !selectedCandidate && (
                         <p className="materials-panel__head-hint">选择一张数据集卡片，再点右上角「下载并分析」开始导入；可多次追加不同数据集</p>
                       )}
                       {canStartPublicFetch && (
                         <p className="materials-panel__head-hint">
                           已选：{selectedCandidate!.title} · v{selectedCandidate!.source_version}
                         </p>
                       )}
                       {selectedImportInReview && selectedCandidateImport && (
                         <p className="materials-panel__head-hint">
                           已选：{selectedCandidate!.title} · v{selectedCandidate!.source_version} · 已导入
                         </p>
                       )}
                       {selectedCandidateImport && isPublicDialogState(selectedCandidateImport.state) && (
                         <p className="materials-panel__head-hint">
                           「{selectedCandidateImport.title}」正在导入
                         </p>
                       )}
                       {dialogImport && !selectedCandidateImport && (
                         <p className="materials-panel__head-hint">正在导入「{dialogImport.title}」</p>
                       )}
                     </div>
                     <div className="materials-panel__head-actions">
                       {canStartPublicFetch && (
                         <button
                           type="button"
                           className="btn-primary materials-panel__head-action"
                           disabled={publicBusy || Boolean(dialogImport) || Boolean(fetchBootstrap)}
                           onClick={startPublicFetch}
                         >
                           {publicBusy && !fetchBootstrap ? "正在创建任务…" : "下载并分析"}
                         </button>
                       )}
                       {selectedImportInReview && (
                         <Link
                           href={`/projects/${id}/review?filter=sample`}
                           className="btn-primary materials-panel__head-action"
                         >
                           去复核
                         </Link>
                       )}
                     </div>
                   </div>
                  <div className="materials-public-layout__body lk-scrollbar">
                     {!showDiscoveryPlan && !discovering && (
                       <div className="materials-public-layout__placeholder">
                         <div className="w-16 h-16 bg-[#F4FAF8] rounded-full flex items-center justify-center mb-4 shadow-sm border border-white">
                           <Icon name="search" size={24} className="text-[#10A88F]" />
                         </div>
                         <p className="text-base font-bold text-[#075F5A]">输入左侧关键词并检索</p>
                       </div>
                     )}

                     {showDiscoveryPlan && discovering && (
                       <div className="materials-public-layout__placeholder materials-public-layout__placeholder--loading">
                         <LoadingScreen fullScreen={false} message="正在分析候选数据集…" />
                       </div>
                     )}

                     {showDiscoveryPlan && !discovering && candidates.length === 0 && publicImports.length === 0 && (
                       <div className="materials-public-layout__placeholder">
                         <div className="w-16 h-16 bg-[#fef3f2] rounded-full flex items-center justify-center mb-4 shadow-sm border border-white">
                           <Icon name="audit" size={24} className="text-[#d92d20]" />
                         </div>
                         <p className="text-base font-bold text-[#d92d20] mb-2">暂未获得可验证的候选</p>
                         <p className="text-sm text-[#17343A]/60 max-w-md text-center">
                           {Object.values(discoveryErrors).map((message) => message.replace(/Kaggle|Roboflow/gi, "公开数据源")).join("；") || "可换个检索词试试。"}
                         </p>
                       </div>
                     )}

                     {showDiscoveryPlan && !discovering && candidates.length > 0 && (
                       <div className="materials-public-layout__results">
                         {discoveryErrors.roboflow_filtered && (
                           <p className="materials-public-layout__filter-note">
                             {discoveryErrors.roboflow_filtered.replace(/Roboflow/gi, "公开数据源")}
                           </p>
                         )}
                         <div className="public-dataset-grid">
                           {candidates.map((candidate, index) => {
                             const matchedImport = publicImports.find(
                               (item) =>
                                 item.license_fingerprint === candidate.license_fingerprint
                                 && !isPublicImportFailed(item.state),
                             );
                             const importStatus = matchedImport
                               ? publicImportCardStatus(matchedImport.state)
                               : null;
                             return (
                             <PublicDatasetCandidateCard
                               key={`${candidate.provider}:${candidate.source_ref}:${candidate.source_version}`}
                               candidate={candidate}
                               recommended={index === 0}
                               selected={selectedCandidate?.license_fingerprint === candidate.license_fingerprint}
                               importStatus={importStatus}
                               onSelect={() => setSelectedCandidate(candidate)}
                             />
                             );
                           })}
                         </div>
                       </div>
                     )}

                     {showDiscoveryPlan && dialogImport && candidates.length === 0 && (
                       <div className="materials-public-layout__placeholder">
                         <div className="w-16 h-16 bg-[#F4FAF8] rounded-full flex items-center justify-center mb-4 shadow-sm border border-white">
                           <Icon name="database" size={24} className="text-[#10A88F]" />
                         </div>
                         <p className="text-base font-bold text-[#075F5A]">正在导入「{dialogImport.title}」</p>
                         <p className="text-sm text-[#17343A]/60">请在弹窗中继续，或放弃后重新检索</p>
                       </div>
                     )}
                   </div>
                </section>
              </div>
            )}
          </div>
        </div>
      </div>

      <input
        ref={videoRef}
        type="file"
        accept="video/*"
        multiple
        hidden
        onChange={(event) => void uploadVideosParallel(Array.from(event.target.files ?? []))}
      />
      <input
        ref={imageRef}
        type="file"
        accept="image/*,.zip,application/zip,application/x-zip-compressed"
        multiple
        hidden
        onChange={(event) => void uploadImages(Array.from(event.target.files ?? []))}
      />

      {uploads.length > 0 && (
        <MaterialsUploadDialog uploads={uploads} uploading={uploading} onClose={closeUploadDialog} />
      )}

      {fetchBootstrap && !dialogImport && (
        <PublicFetchPreparingDialog
          bootstrap={fetchBootstrap}
          onClose={() => setFetchBootstrap(null)}
        />
      )}

      {showPublicImportDialog && dialogImport && (
        <PublicDatasetImportDialog
          publicImport={dialogImport}
          project={project}
          publicBusy={publicBusy}
          fetchProgress={fetchTaskProgress}
          classMapping={classMapping}
          setClassMapping={setClassMapping}
          publishAnnotationCount={publishAnnotationCount}
          publishClassDistribution={publishClassDistribution}
          publishLabelsFullyIgnored={publishLabelsFullyIgnored}
          publishBlockingIssues={publishBlockingIssues}
          publishWarnings={publishWarnings}
          canDiscard={canDiscardPublicImport}
          canPublish={canPublishPublicImport}
          onDiscard={discardPublicImport}
          onPublish={startPublicPublish}
        />
      )}

    </div>
  );
}
