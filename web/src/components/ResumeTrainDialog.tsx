"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/Icon";
import { ModalSurface } from "@/components/ui/motion";

export type ResumeTrainParams = {
  epochs: number;
  imgsz: number;
  batch: number;
  device: string;
  workers: number;
  patience: number;
  lr0: number;
  optimizer: string;
  seed: number;
  close_mosaic: number;
  weight_decay: number;
  warmup_epochs: number;
};

type SourceTask = {
  id: string;
  progress: number;
  total: number;
  params: Record<string, unknown>;
  project_name?: string;
};

type Props = {
  open: boolean;
  task: SourceTask | null;
  submitting?: boolean;
  showCloseMosaic?: boolean;
  onClose: () => void;
  onConfirm: (params: ResumeTrainParams) => void;
};

function num(value: unknown, fallback: number) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function str(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export function paramsFromTask(task: SourceTask): ResumeTrainParams {
  const p = task.params ?? {};
  return {
    epochs: Math.max(num(p.epochs, task.total || 80), Math.max(1, task.progress || 1)),
    imgsz: num(p.imgsz, 640),
    batch: num(p.batch, 8),
    device: str(p.device, "auto"),
    workers: num(p.workers, 0),
    patience: num(p.patience, 50),
    lr0: num(p.lr0, 0.01),
    optimizer: str(p.optimizer, "auto"),
    seed: num(p.seed, 0),
    close_mosaic: num(p.close_mosaic, 10),
    weight_decay: num(p.weight_decay, 0.0005),
    warmup_epochs: num(p.warmup_epochs, 3),
  };
}

export function ResumeTrainDialog({
  open,
  task,
  submitting = false,
  showCloseMosaic = true,
  onClose,
  onConfirm,
}: Props) {
  const [mounted, setMounted] = useState(false);
  const [form, setForm] = useState<ResumeTrainParams | null>(null);
  const formTask = useRef<string | null>(null);
  const submittingRef = useRef(false);
  useEffect(() => { if (!submitting) submittingRef.current = false; }, [submitting]);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!open) { formTask.current = null; submittingRef.current = false; }
    else if (task && formTask.current !== task.id) { setForm(paramsFromTask(task)); formTask.current = task.id; }
  }, [open, task]);

  const taskCode = useMemo(() => {
    if (!task) return "";
    return `TASK-${task.id.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
  }, [task]);

  if (!mounted) return null;

  const setField = <K extends keyof ResumeTrainParams>(key: K, value: ResumeTrainParams[K]) => {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

  return createPortal(
    <ModalSurface open={Boolean(open && task && form)} onClose={onClose} busy={submitting}>
    {task && form && (
      <div
        className="materials-public-import-dialog resume-train-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="resume-train-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="materials-public-import-dialog__head">
          <div>
            <h2 id="resume-train-dialog-title">继续训练</h2>
            <p>
              {taskCode}
              {task.project_name ? ` · ${task.project_name}` : ""}
              {` · 断点 ${task.progress}/${task.total || "?"} · 默认沿用原训练参数，可按需调整后启动`}
            </p>
          </div>
          <button
            type="button"
            className="modal-close-button"
            aria-label="关闭"
            disabled={submitting}
            onClick={onClose}
          >
            <Icon name="x" size={18} />
          </button>
        </header>

        <div className="materials-public-import-dialog__body lk-scrollbar resume-train-dialog__body">
          <div className="resume-train-dialog__grid">
            <label>
              <span>训练轮数（总目标）</span>
              <input
                className="input"
                type="number"
                min={Math.max(1, task.progress)}
                value={form.epochs}
                onChange={(e) => setField("epochs", Number(e.target.value))}
              />
            </label>
            <label>
              <span>输入尺寸</span>
              <input
                className="input"
                type="number"
                min={320}
                step={32}
                value={form.imgsz}
                onChange={(e) => setField("imgsz", Number(e.target.value))}
              />
            </label>
            <label>
              <span>批次大小</span>
              <input
                className="input"
                type="number"
                min={1}
                value={form.batch}
                onChange={(e) => setField("batch", Number(e.target.value))}
              />
            </label>
            <label>
              <span>计算设备</span>
              <select
                className="input"
                value={form.device}
                onChange={(e) => setField("device", e.target.value)}
              >
                <option value="auto">自动选择（CUDA → MPS → CPU）</option>
                <option value="mps">Apple GPU (MPS)</option>
                <option value="cpu">CPU（较慢）</option>
                <option value="0">NVIDIA GPU (CUDA)</option>
              </select>
            </label>
            <label>
              <span>数据加载线程</span>
              <input
                className="input"
                type="number"
                min={0}
                max={32}
                value={form.workers}
                onChange={(e) => setField("workers", Number(e.target.value))}
              />
            </label>
            <label>
              <span>早停耐心</span>
              <input
                className="input"
                type="number"
                min={0}
                value={form.patience}
                onChange={(e) => setField("patience", Number(e.target.value))}
              />
            </label>
            <label>
              <span>初始学习率</span>
              <input
                className="input"
                type="number"
                min={0.0001}
                max={1}
                step={0.001}
                value={form.lr0}
                onChange={(e) => setField("lr0", Number(e.target.value))}
              />
            </label>
            <label>
              <span>优化器</span>
              <select
                className="input"
                value={form.optimizer}
                onChange={(e) => setField("optimizer", e.target.value)}
              >
                <option value="auto">自动</option>
                <option value="SGD">SGD</option>
                <option value="Adam">Adam</option>
                <option value="AdamW">AdamW</option>
                <option value="RMSProp">RMSProp</option>
              </select>
            </label>
            <label>
              <span>随机种子</span>
              <input
                className="input"
                type="number"
                min={0}
                value={form.seed}
                onChange={(e) => setField("seed", Number(e.target.value))}
              />
            </label>
            <label>
              <span>权重衰减</span>
              <input
                className="input"
                type="number"
                min={0}
                step={0.0001}
                value={form.weight_decay}
                onChange={(e) => setField("weight_decay", Number(e.target.value))}
              />
            </label>
            <label>
              <span>预热轮数</span>
              <input
                className="input"
                type="number"
                min={0}
                step={0.5}
                value={form.warmup_epochs}
                onChange={(e) => setField("warmup_epochs", Number(e.target.value))}
              />
            </label>
            {showCloseMosaic ? (
              <label>
                <span>关闭 Mosaic（末 N 轮）</span>
                <input
                  className="input"
                  type="number"
                  min={0}
                  value={form.close_mosaic}
                  onChange={(e) => setField("close_mosaic", Number(e.target.value))}
                />
              </label>
            ) : null}
          </div>
          <p className="resume-train-dialog__hint">
            权重固定使用断点 last.pt，数据集沿用原训练目录。若先前因内存不足中断，建议将 batch / workers 调低后再启动。
          </p>
        </div>

        <footer className="materials-public-import-dialog__footer">
          <button type="button" className="btn-secondary" disabled={submitting} onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={submitting || form.epochs < Math.max(1, task.progress)}
            onClick={() => { if (!submittingRef.current) { submittingRef.current = true; onConfirm(form); } }}
          >
            <Icon name="play" size={14} />
            {submitting ? "启动中…" : "开始续训"}
          </button>
        </footer>
      </div>
    )}
    </ModalSurface>,
    document.body,
  );
}
