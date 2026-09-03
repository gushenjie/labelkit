"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, DatasetVersionSummary, ModelVersion, Project, Task } from "@/lib/api";
import { countConfirmed } from "@/lib/status";
import { ProjectPageHeader } from "@/components/ProjectPageHeader";
import { WorkflowNextButton } from "@/components/WorkflowNextButton";
import { WORKFLOW_STEPS } from "@/lib/workflow";
import { Panel, PanelSection } from "@/components/ui/Panel";
import { TaskProgress } from "@/components/ui/TaskProgress";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/ToastProvider";
import { Icon } from "@/components/Icon";
import { TrainLogPanel } from "@/components/TrainLogPanel";
import { formatTrainLog } from "@/lib/train-log";

const EXPORT_DIR_KEY = "labelkit-export-dir";

function safeDirName(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, "_").trim() || "dataset";
}

const TRAIN_STATUS_ZH: Record<string, string> = {
  pending: "排队中",
  running: "进行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

export default function TrainPage() {
  const { id } = useParams<{ id: string }>();
  const confirm = useConfirm();
  const { toast } = useToast();
  const [mounted, setMounted] = useState(false);
  const [project, setProject] = useState<Project | null>(null);
  const [models, setModels] = useState<ModelVersion[]>([]);
  const [datasetVersions, setDatasetVersions] = useState<DatasetVersionSummary[]>([]);
  const [datasetVersionId, setDatasetVersionId] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [epochs, setEpochs] = useState(80);
  const [imgsz, setImgsz] = useState(640);
  const [batch, setBatch] = useState(8);
  const [device, setDevice] = useState("auto");
  const [stats, setStats] = useState<Record<string, number>>({});
  const [starting, setStarting] = useState(false);
  const [exportDir, setExportDir] = useState("");
  const [valRatio, setValRatio] = useState(20);
  const [exportError, setExportError] = useState("");
  const [picking, setPicking] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportRunning, setExportRunning] = useState(false);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [exportDone, setExportDone] = useState<{
    path: string;
    train: number;
    val: number;
  } | null>(null);
  const [monitorTask, setMonitorTask] = useState<Task | null>(null);
  const [stopping, setStopping] = useState(false);
  const prevExportRunning = useRef(false);

  const openExportDir = async (path: string) => {
    try {
      await api.openPath(path);
    } catch (e) {
      setExportError(String(e));
    }
  };

  const refresh = () => {
    if (!id) return;
    api.getProject(id).then(setProject);
    api.listModels(id).then(setModels);
    api.getDatasetCatalog({ projectId: id, limit: 200 }).then((catalog) => setDatasetVersions(catalog.items));
    api.listTasks(id).then((t) => {
      setTasks(t.filter((x) => x.task_type === "train"));
      setExportRunning(t.some((x) => x.task_type === "export" && x.status === "running"));
    });
    api.frameStats(id).then(setStats);
  };

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    const saved = localStorage.getItem(EXPORT_DIR_KEY);
    if (saved) setExportDir(saved);
    const requestedVersion = new URLSearchParams(window.location.search).get("datasetVersion");
    if (requestedVersion) setDatasetVersionId(requestedVersion);
    if (window.location.hash === "#dataset-export") setExportModalOpen(true);
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [id]);

  useEffect(() => {
    if (!exportModalOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !exporting && !exportRunning) setExportModalOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [exportModalOpen, exporting, exportRunning]);

  useEffect(() => {
    if (!id) return;
    if (prevExportRunning.current && !exportRunning) {
      api.listTasks(id).then((t) => {
        const lastExport = t
          .filter((x) => x.task_type === "export")
          .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
        if (lastExport?.status === "completed" && lastExport.result?.path) {
          const path = String(lastExport.result.path);
          const s = (lastExport.result.stats ?? {}) as { train?: number; val?: number };
          setExportDone({
            path,
            train: s.train ?? 0,
            val: s.val ?? 0,
          });
          openExportDir(path);
        } else if (lastExport?.status === "failed") {
          setExportError(lastExport.error || "导出失败");
          setExportModalOpen(true);
        }
      });
    }
    prevExportRunning.current = exportRunning;
  }, [exportRunning, id]);

  const startTrain = async () => {
    if (!id) return;
    setStarting(true);
    try {
      await api.createTask(id, "train", {
        epochs,
        imgsz,
        batch,
        device,
        val_ratio: valRatio / 100,
        ...(datasetVersionId ? { dataset_version_id: datasetVersionId } : {}),
      });
      refresh();
    } finally {
      setStarting(false);
    }
  };

  const pickExportDir = async () => {
    setPicking(true);
    setExportError("");
    try {
      const { path } = await api.pickFolder();
      const base = path.replace(/\/$/, "");
      const sub = project ? `${safeDirName(project.name)}-dataset` : "dataset-export";
      const full = `${base}/${sub}`;
      setExportDir(full);
      localStorage.setItem(EXPORT_DIR_KEY, full);
    } catch (e) {
      const msg = String(e);
      if (!msg.includes("未选择")) setExportError(msg);
    } finally {
      setPicking(false);
    }
  };

  const startExport = async () => {
    if (!id) return;
    const dir = exportDir.trim();
    if (!dir) {
      setExportError("请先选择或填写导出目录");
      return;
    }
    if (
      !(await confirm({
        title: "确认导出",
        message: `将导出 YOLO 数据集到：\n${dir}\n\n若该目录已有文件将被覆盖。是否继续？`,
        confirmLabel: "开始导出",
      }))
    ) {
      return;
    }
    setExporting(true);
    setExportError("");
    setExportDone(null);
    try {
      await api.createTask(id, "export", {
        output_dir: dir,
        overwrite: true,
        val_ratio: valRatio / 100,
        ...(datasetVersionId ? { dataset_version_id: datasetVersionId } : {}),
      });
      localStorage.setItem(EXPORT_DIR_KEY, dir);
      setExportModalOpen(false);
      refresh();
      toast({ type: "info", message: "导出任务已启动，可在任务中心查看进度" });
    } catch (e) {
      setExportError(String(e));
    } finally {
      setExporting(false);
    }
  };

  const trainable =
    (stats.auto_ok ?? 0) +
    (stats.auto_fixed ?? 0) +
    (stats.human_ok ?? 0) +
    (stats.no_target ?? 0);
  const confirmedCount = countConfirmed(stats);
  const selectedDataset = datasetVersions.find((item) => item.id === datasetVersionId) ?? null;
  const activeTrain = tasks.find((t) => t.status === "running");
  const latestTrain = useMemo(
    () => [...tasks].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0] ?? null,
    [tasks],
  );
  const monitorTaskId = activeTrain?.id ?? latestTrain?.id ?? null;
  const displayedTrain = monitorTask ?? activeTrain ?? latestTrain;
  const trainLogLines = useMemo(
    () => formatTrainLog(displayedTrain?.log ?? ""),
    [displayedTrain?.log],
  );

  useEffect(() => {
    if (!id || !monitorTaskId) {
      setMonitorTask(null);
      return;
    }
    const load = () => api.getTask(id, monitorTaskId).then(setMonitorTask).catch(() => {});
    load();
    const interval = window.setInterval(load, activeTrain ? 2000 : 5000);
    return () => window.clearInterval(interval);
  }, [id, monitorTaskId, activeTrain?.id]);

  const valCount = selectedDataset?.val_count ?? (trainable > 1 ? Math.max(1, Math.min(trainable - 1, Math.round(trainable * (valRatio / 100)))) : 0);
  const trainCount = selectedDataset?.train_count ?? (trainable - valCount);
  const availableCount = selectedDataset?.sample_count ?? trainable;
  const trainCopy = WORKFLOW_STEPS.find((step) => step.slug === "train")!;
  const exportDisabled = availableCount === 0 || exporting || exportRunning || !exportDir.trim();

  const stopTrain = async () => {
    if (!id || stopping) return;
    if (
      !(await confirm({
        title: "停止训练",
        message: "确定要停止当前训练任务吗？已完成的 epoch 进度将保留，但训练不会继续。",
        confirmLabel: "停止训练",
        danger: true,
      }))
    ) {
      return;
    }
    setStopping(true);
    try {
      if (activeTrain) await api.cancelTask(id, activeTrain.id);
      else await api.cancelRunningTask(id);
      refresh();
    } finally {
      setStopping(false);
    }
  };

  return (
    <div className="train-page train-page--fit">
      <ProjectPageHeader
        title="训练或导出"
        description={trainCopy.pageDescription}
        eyebrow="Model production"
        action={
          models.length > 0 ? (
            <WorkflowNextButton href={`/models?project=${id}`} label="模型中心" />
          ) : (
            <WorkflowNextButton label="模型中心" disabled disabledHint="训练完成后可用" />
          )
        }
      />

      <section className="train-summary shrink-0" aria-label="训练准备状态">
        <div className={availableCount > 0 ? "train-summary__ready" : undefined}>
          <span>
            <Icon name="check" size={16} />
          </span>
          <div>
            <strong>{availableCount}</strong>
            <small>{selectedDataset ? "版本样本" : "可训练样本"}</small>
          </div>
        </div>
        <div>
          <span>
            <Icon name="layers" size={16} />
          </span>
          <div>
            <strong>{trainCount}</strong>
            <small>训练集</small>
          </div>
        </div>
        <div>
          <span>
            <Icon name="image" size={16} />
          </span>
          <div>
            <strong>{valCount}</strong>
            <small>验证集</small>
          </div>
        </div>
        <Link href={`/models?project=${id}`} className="train-summary__link" title="查看模型中心">
          <span>
            <Icon name="package" size={16} />
          </span>
          <div>
            <strong>{models.length}</strong>
            <small>模型版本 →</small>
          </div>
        </Link>
        <div className="train-summary__state">
          <i aria-hidden="true" />
          <div>
            <strong>{activeTrain ? "训练运行中" : availableCount > 0 ? "训练已就绪" : "等待确认数据"}</strong>
            <small>{activeTrain ? `${activeTrain.progress}/${activeTrain.total}` : "YOLO 迁移学习"}</small>
          </div>
        </div>
      </section>

      <div className="train-page__body">
        <div className="train-layout train-layout--fill h-full">
          <Panel className="train-control-panel h-full lk-scrollbar">
        <PanelSection title="数据集就绪度">
          <label className="dataset-version-selector">
            <span>训练数据来源</span>
            <select className="input" value={datasetVersionId} onChange={(event) => setDatasetVersionId(event.target.value)}>
              <option value="">当前已确认数据（启动时创建新版本）</option>
              {datasetVersions.map((version) => (
                <option key={version.id} value={version.id}>
                  数据集 v{version.version} · {version.sample_count} 张 · {new Date(version.created_at).toLocaleDateString("zh-CN")}
                </option>
              ))}
            </select>
          </label>
          <p className="text-sm text-muted">
            {selectedDataset ? "固定版本样本" : "可训练样本"}：<strong className="text-ink">{availableCount}</strong> 张
            {!selectedDataset && confirmedCount > 0 && confirmedCount !== trainable && (
              <span className="text-subtle">（其中人工确认 {confirmedCount} 张）</span>
            )}
          </p>
          {availableCount > 0 ? (
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <div className="w-32">
                <label className="mb-1 block text-xs text-muted">验证集比例</label>
                <div className="flex items-center gap-1">
                  <input
                    className="input"
                    type="number"
                    min={5}
                    max={50}
                    disabled={!!selectedDataset}
                    value={valRatio}
                    onChange={(e) => setValRatio(Number(e.target.value))}
                  />
                  <span className="text-sm text-muted">%</span>
                </div>
              </div>
              <p className="pb-2 text-xs text-subtle">
                {selectedDataset ? "固定划分" : "预计划分"}：训练 <strong>{trainCount}</strong> 张 · 验证 <strong>{valCount}</strong> 张
              </p>
              {selectedDataset && (
                <p className="dataset-version-lock">
                  <Icon name="lock" size={13} />
                  正在复用数据集 v{selectedDataset.version}，划分和标签不会随当前项目修改。
                </p>
              )}
            </div>
          ) : (
            <p className="mt-2 text-sm text-warning-600">
              还没有可训练数据，请先在
              <Link href={`/projects/${id}/review`} className="mx-1 text-brand-600 hover:underline">③ 标注复核</Link>
              里确认标注
            </p>
          )}
        </PanelSection>

        <PanelSection title="训练参数">
          <p className="text-xs text-subtle">
            基于 {project?.task_type === "classify" ? "YOLOv8s-cls" : "YOLOv8s"} 预训练权重，在本项目数据上微调
          </p>
          <div className="train-control-panel__grid grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted">训练轮数</label>
              <input className="input" type="number" min={1} value={epochs} onChange={(e) => setEpochs(Number(e.target.value))} />
            </div>
            <div>
              <label className="text-xs text-muted">输入尺寸</label>
              <input className="input" type="number" min={320} step={32} value={imgsz} onChange={(e) => setImgsz(Number(e.target.value))} />
            </div>
            <div>
              <label className="text-xs text-muted">批次大小</label>
              <input className="input" type="number" min={1} value={batch} onChange={(e) => setBatch(Number(e.target.value))} />
            </div>
            <div>
              <label className="text-xs text-muted">计算设备</label>
              <select className="input" value={device} onChange={(e) => setDevice(e.target.value)}>
                <option value="auto">自动选择（CUDA → MPS → CPU）</option>
                <option value="mps">Apple GPU (MPS)</option>
                <option value="cpu">CPU（较慢）</option>
                <option value="0">NVIDIA GPU (CUDA)</option>
              </select>
            </div>
          </div>

          <div className="train-control-panel__actions">
            <button
              className="btn-primary"
              disabled={availableCount === 0 || starting || !!activeTrain}
              onClick={startTrain}
            >
              <Icon name="play" size={15} />
              {activeTrain ? "训练进行中…" : starting ? "启动中…" : "开始训练"}
            </button>
            {activeTrain && (
              <button type="button" className="btn-danger" disabled={stopping} onClick={stopTrain}>
                <Icon name="x" size={15} />
                {stopping ? "停止中…" : "停止训练"}
              </button>
            )}
            <button
              type="button"
              className="btn-secondary"
              disabled={availableCount === 0 || exportRunning}
              onClick={() => {
                setExportError("");
                setExportModalOpen(true);
              }}
            >
              <Icon name="archive" size={15} />
              {exportRunning ? "导出进行中…" : "导出数据集"}
            </button>
          </div>

          {exportDone && !exportModalOpen && (
            <div className="operations-alert operations-alert--success">
              最近导出 · 训练 {exportDone.train} 张 / 验证 {exportDone.val} 张
              <button type="button" className="ml-3 text-brand-600 hover:underline" onClick={() => openExportDir(exportDone.path)}>
                打开文件夹
              </button>
            </div>
          )}
          </PanelSection>
            </Panel>

            <aside className="train-monitor" aria-label="训练进度与日志">
              <div className="train-monitor__head">
                <h3>训练进度</h3>
                <span className="train-monitor__status">
                  {displayedTrain
                    ? TRAIN_STATUS_ZH[displayedTrain.status] ?? displayedTrain.status
                    : "等待开始"}
                </span>
              </div>

              {displayedTrain && (displayedTrain.status === "running" || displayedTrain.total > 0) ? (
                <TaskProgress
                  label={displayedTrain.status === "running" ? "当前训练" : "最近训练"}
                  progress={displayedTrain.progress}
                  total={displayedTrain.total}
                  onStop={displayedTrain.status === "running" ? stopTrain : undefined}
                  stopping={stopping}
                />
              ) : (
                <div className="train-monitor__empty">点击「开始训练」后，这里会显示 epoch 进度</div>
              )}

              {displayedTrain?.status === "failed" && displayedTrain.error && (
                <div className="operations-alert operations-alert--danger mt-3">
                  {displayedTrain.error}
                </div>
              )}

              {displayedTrain?.status === "completed" && displayedTrain.result?.version != null && (
                <div className="operations-alert operations-alert--success mt-3">
                  训练完成 · 产出模型 v{displayedTrain.result.version as number}
                  {" · "}
                  <Link href={`/models?project=${id}`} className="text-brand-600 hover:underline">去模型中心</Link>
                </div>
              )}

              <div className="train-monitor__log-wrap">
                <div className="train-monitor__head">
                  <h3>训练日志</h3>
                  {displayedTrain && (
                    <span className="train-monitor__status">{trainLogLines.length} 行</span>
                  )}
                </div>
                <TrainLogPanel
                  lines={trainLogLines}
                  emptyText={activeTrain ? "等待训练输出…" : "暂无训练日志"}
                />
              </div>
            </aside>
          </div>
        </div>

      {mounted && exportModalOpen && createPortal(
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !exporting && !exportRunning) {
              setExportModalOpen(false);
            }
          }}
        >
          <div
            className="materials-public-import-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="export-dataset-dialog-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="materials-public-import-dialog__head">
              <div>
                <h2 id="export-dataset-dialog-title">导出数据集</h2>
                <p>
                  导出为标准 YOLO 目录（images/train、images/val、labels、dataset.yaml）
                  · 当前划分：训练 {trainCount} 张 / 验证 {valCount} 张
                </p>
              </div>
              <button
                type="button"
                className="modal-close-button"
                aria-label="关闭"
                disabled={exporting || exportRunning}
                onClick={() => setExportModalOpen(false)}
              >
                <Icon name="x" size={18} />
              </button>
            </header>
            <div className="materials-public-import-dialog__body lk-scrollbar space-y-3">
              <div className="flex flex-wrap gap-2">
                <input
                  className="input min-w-0 flex-1 font-mono text-sm"
                  placeholder="/Users/你的用户名/Desktop/火焰检测-dataset"
                  value={exportDir}
                  onChange={(e) => setExportDir(e.target.value)}
                />
                <button type="button" className="btn-secondary shrink-0" disabled={picking} onClick={pickExportDir}>
                  {picking ? "选择中…" : "选择文件夹"}
                </button>
              </div>
              {exportError && <p className="text-sm text-danger-600">{exportError}</p>}
              {exportDone && (
                <div className="rounded-lg border border-brand-100 bg-brand-50 px-3 py-2 text-sm text-brand-700">
                  导出完成 · 训练 {exportDone.train} 张 / 验证 {exportDone.val} 张
                  <button type="button" className="ml-3 text-brand-600 hover:underline" onClick={() => openExportDir(exportDone.path)}>
                    打开文件夹
                  </button>
                </div>
              )}
            </div>
            <footer className="materials-public-import-dialog__footer">
              <button type="button" className="btn-secondary" disabled={exporting || exportRunning} onClick={() => setExportModalOpen(false)}>
                取消
              </button>
              <button type="button" className="btn-primary" disabled={exportDisabled} onClick={startExport}>
                {exportRunning || exporting ? "导出进行中…" : "导出数据集"}
              </button>
            </footer>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
