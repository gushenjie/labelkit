"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api, ModelVersion, Project, Task } from "@/lib/api";
import { countConfirmed } from "@/lib/status";
import { ProjectPageHeader } from "@/components/ProjectPageHeader";
import { Panel, PanelSection } from "@/components/ui/Panel";
import { TaskProgress } from "@/components/ui/TaskProgress";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/ToastProvider";
import { Icon } from "@/components/Icon";

const EXPORT_DIR_KEY = "labelkit-export-dir";

const TASK_STATUS_ZH: Record<string, string> = {
  pending: "排队中",
  running: "进行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

function safeDirName(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, "_").trim() || "dataset";
}

export default function TrainPage() {
  const { id } = useParams<{ id: string }>();
  const confirm = useConfirm();
  const { toast } = useToast();
  const [project, setProject] = useState<Project | null>(null);
  const [models, setModels] = useState<ModelVersion[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [epochs, setEpochs] = useState(80);
  const [imgsz, setImgsz] = useState(640);
  const [batch, setBatch] = useState(8);
  const [device, setDevice] = useState("mps");
  const [stats, setStats] = useState<Record<string, number>>({});
  const [starting, setStarting] = useState(false);
  const [exportDir, setExportDir] = useState("");
  const [valRatio, setValRatio] = useState(20);
  const [exportError, setExportError] = useState("");
  const [picking, setPicking] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportRunning, setExportRunning] = useState(false);
  const [exportDone, setExportDone] = useState<{
    path: string;
    train: number;
    val: number;
  } | null>(null);
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
    api.listTasks(id).then((t) => {
      setTasks(t.filter((x) => x.task_type === "train"));
      setExportRunning(t.some((x) => x.task_type === "export" && x.status === "running"));
    });
    api.frameStats(id).then(setStats);
  };

  useEffect(() => {
    const saved = localStorage.getItem(EXPORT_DIR_KEY);
    if (saved) setExportDir(saved);
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [id]);

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
        base_model: "yolov8s.pt",
        val_ratio: valRatio / 100,
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
      });
      localStorage.setItem(EXPORT_DIR_KEY, dir);
      refresh();
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
  const activeTrain = tasks.find((t) => t.status === "running");
  const valCount = trainable > 1 ? Math.max(1, Math.min(trainable - 1, Math.round(trainable * (valRatio / 100)))) : 0;
  const trainCount = trainable - valCount;

  return (
    <div className="operations-page train-page">
      <ProjectPageHeader
        title="训练与导出"
        description="用已确认标注训练 YOLO 模型，或导出标准数据集"
        eyebrow="Model production"
      />

      <section className="train-summary" aria-label="训练准备状态">
        <div className={trainable > 0 ? "train-summary__ready" : ""}>
          <span><Icon name="check" size={17} /></span>
          <div><strong>{trainable}</strong><small>可训练样本</small></div>
        </div>
        <div>
          <span><Icon name="layers" size={17} /></span>
          <div><strong>{trainCount}</strong><small>训练集</small></div>
        </div>
        <div>
          <span><Icon name="image" size={17} /></span>
          <div><strong>{valCount}</strong><small>验证集</small></div>
        </div>
        <div>
          <span><Icon name="package" size={17} /></span>
          <div><strong>{models.length}</strong><small>模型版本</small></div>
        </div>
        <div className="train-summary__state">
          <i aria-hidden="true" />
          <div>
            <strong>{activeTrain ? "训练运行中" : trainable > 0 ? "训练已就绪" : "等待确认数据"}</strong>
            <small>{activeTrain ? `${activeTrain.progress}/${activeTrain.total}` : "YOLOv8s 迁移学习"}</small>
          </div>
        </div>
      </section>

      <div className="train-layout">
        <div className="train-layout__main">
          <Panel className="train-control-panel">
            <PanelSection title="数据集就绪度">
              <p className="text-sm text-muted">
                可训练样本：<strong className="text-ink">{trainable}</strong> 张
                {confirmedCount > 0 && confirmedCount !== trainable && (
                  <span className="text-subtle">（其中人工确认 {confirmedCount} 张）</span>
                )}
              </p>
              {trainable > 0 ? (
                <div className="mt-3 flex flex-wrap items-end gap-3">
                  <div className="w-32">
                    <label className="mb-1 block text-xs text-muted">验证集比例</label>
                    <div className="flex items-center gap-1">
                      <input
                        className="input"
                        type="number"
                        min={5}
                        max={50}
                        value={valRatio}
                        onChange={(e) => setValRatio(Number(e.target.value))}
                      />
                      <span className="text-sm text-muted">%</span>
                    </div>
                  </div>
                  <p className="pb-2 text-xs text-subtle">
                    预计划分：训练 <strong>{trainCount}</strong> 张 · 验证 <strong>{valCount}</strong> 张
                  </p>
                </div>
              ) : (
                <p className="mt-2 text-sm text-warning-600">
                  还没有可训练数据，请先在
                  <Link href={`/projects/${id}/review`} className="mx-1 text-brand-600 hover:underline">③ 人工确认</Link>
                  里确认标注
                </p>
              )}
            </PanelSection>

            <PanelSection title="训练参数">
              <p className="text-xs text-subtle">基于 YOLOv8s 预训练权重，在本项目数据上微调</p>
              <div className="grid grid-cols-2 gap-3">
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
                    <option value="mps">Apple GPU (MPS)</option>
                    <option value="cpu">CPU（较慢）</option>
                    <option value="0">NVIDIA GPU (CUDA)</option>
                  </select>
                </div>
              </div>
              <button
                className="btn-primary"
                disabled={trainable === 0 || starting || !!activeTrain}
                onClick={startTrain}
              >
                <Icon name="play" size={15} />
                {activeTrain ? "训练进行中…" : starting ? "启动中…" : "开始训练"}
              </button>
              {activeTrain && (
                <TaskProgress
                  label="当前训练"
                  progress={activeTrain.progress}
                  total={activeTrain.total}
                />
              )}
            </PanelSection>
          </Panel>
        </div>

        <div className="train-layout__side">
          <Panel className="train-output-panel">
            <PanelSection title="模型版本">
              {models.length === 0 ? (
                <p className="text-sm text-subtle">
                  暂无模型 ·{" "}
                  <Link href={`/models?project=${id}`} className="text-brand-600 hover:underline">去上传</Link>
                </p>
              ) : (
                <ul className="space-y-2">
                  {models.slice(0, 8).map((m) => (
                    <li key={m.id} className="rounded-lg border border-border px-3 py-2 text-sm">
                      <div className="font-medium text-ink">{m.name}</div>
                      <div className="text-xs text-subtle">版本 v{m.version}</div>
                    </li>
                  ))}
                </ul>
              )}
              {models.length > 0 && (
                <Link href={`/models?project=${id}`} className="text-xs text-brand-600 hover:underline">
                  查看全部模型 →
                </Link>
              )}
            </PanelSection>

            <PanelSection title="导出数据集">
              <p className="text-xs text-subtle">
                导出为标准 YOLO 目录（images/train、images/val、labels、dataset.yaml）
              </p>
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
              <button
                className="btn-secondary"
                disabled={trainable === 0 || exporting || exportRunning || !exportDir.trim()}
                onClick={startExport}
              >
                {exportRunning || exporting ? "导出进行中…" : "导出数据集"}
              </button>
            </PanelSection>
          </Panel>
        </div>
      </div>

      {tasks.length > 0 && (
        <Panel className="train-history">
          <PanelSection title="训练记录">
            {tasks.map((t) => (
              <div key={t.id} className="mb-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-brand-600">模型训练</span>
                  <span className="text-muted">{TASK_STATUS_ZH[t.status] ?? t.status}</span>
                </div>
                {t.status === "running" && (
                  <TaskProgress progress={t.progress} total={t.total} />
                )}
                {t.error && <p className="text-xs text-danger-600">{t.error}</p>}
              </div>
            ))}
          </PanelSection>
        </Panel>
      )}
    </div>
  );
}
