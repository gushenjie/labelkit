"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { api, Frame, Task } from "@/lib/api";
import { FrameLightbox } from "@/components/FrameLightbox";

const TASK_LABEL: Record<string, string> = {
  extract: "提取素材",
  dedup: "素材去重",
  label: "自动标注",
  review: "自动审查",
  train: "训练模型",
  export: "导出数据",
  relabel: "YOLO 半自动",
  import: "导入数据",
  derive_classify: "生成分类集",
};

const STATUS_ZH: Record<string, string> = {
  pending: "等待中",
  running: "进行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  paused: "已暂停",
};

type Props = {
  task: Task & { projectName: string };
  onCancel?: () => void;
};

function StatRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1.5 text-sm">
      <span className="text-muted">{label}</span>
      <span className="text-right text-ink">{value}</span>
    </div>
  );
}

function ResultBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-4 rounded-lg border border-border bg-surface-soft p-3">
      <h3 className="mb-2 text-xs font-medium text-muted">{title}</h3>
      {children}
    </div>
  );
}

function formatLogLines(log: string): string[] {
  return log
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-8);
}

/** 已有结构化结果摘要时，不再重复展示含路径的执行日志 */
function hideLogForTask(task: Task): boolean {
  if (task.status !== "completed" || !task.result) return false;
  if (task.task_type === "export" && task.result.stats) return true;
  return false;
}

const ONLY_STATUS_ZH: Record<string, string> = {
  human_wrong: "已驳回",
  unlabeled: "未标注",
  pending: "待确认",
};

function TaskResultSummary({ task }: { task: Task }) {
  const r = task.result;
  if (!r || Object.keys(r).length === 0) return null;

  if (task.task_type === "export") {
    const stats = r.stats as { train?: number; val?: number; total?: number } | undefined;
    const path = r.path as string | undefined;
    return (
      <ResultBlock title="导出结果">
        {stats && (
          <div className="mb-3 grid grid-cols-3 gap-2 text-center text-sm">
            <div className="rounded bg-surface-soft px-2 py-2">
              <div className="text-lg font-semibold text-ink">{stats.train ?? 0}</div>
              <div className="text-xs text-subtle">训练集</div>
            </div>
            <div className="rounded bg-surface-soft px-2 py-2">
              <div className="text-lg font-semibold text-ink">{stats.val ?? 0}</div>
              <div className="text-xs text-subtle">验证集</div>
            </div>
            <div className="rounded bg-surface-soft px-2 py-2">
              <div className="text-lg font-semibold text-brand-600">{stats.total ?? 0}</div>
              <div className="text-xs text-subtle">合计</div>
            </div>
          </div>
        )}
        {path && (
          <button
            type="button"
            className="btn-secondary text-xs"
            onClick={() => api.openPath(path).catch(() => {})}
          >
            打开文件夹
          </button>
        )}
      </ResultBlock>
    );
  }

  if (task.task_type === "extract" || task.task_type === "dedup") {
    const extracted = r.extracted as number | undefined;
    const kept = r.kept as number | undefined;
    const removed = r.removed as number | undefined;
    return (
      <ResultBlock title="提取结果">
        {extracted != null && <StatRow label="抽出帧数" value={`${extracted} 张`} />}
        {kept != null && <StatRow label="去重保留" value={`${kept} 张`} />}
        {removed != null && <StatRow label="去重删除" value={`${removed} 张`} />}
      </ResultBlock>
    );
  }

  if (task.task_type === "relabel" || task.task_type === "label") {
    const ok = r.ok as number | undefined;
    const fail = r.fail as number | undefined;
    return (
      <ResultBlock title="处理结果">
        {ok != null && <StatRow label="成功" value={`${ok} 张`} />}
        {fail != null && <StatRow label="失败" value={`${fail} 张`} />}
        {r.only_status != null && r.only_status !== "" && (
          <StatRow label="范围" value={ONLY_STATUS_ZH[String(r.only_status)] ?? String(r.only_status)} />
        )}
      </ResultBlock>
    );
  }

  if (task.task_type === "train") {
    const dataset = r.dataset as { train?: number; val?: number; total?: number } | undefined;
    const version = r.version as number | undefined;
    return (
      <ResultBlock title="训练结果">
        {version != null && <StatRow label="模型版本" value={`v${version}`} />}
        {dataset && (
          <StatRow
            label="数据集"
            value={`训练 ${dataset.train ?? 0} / 验证 ${dataset.val ?? 0}`}
          />
        )}
        {r.model_path != null && r.model_path !== "" && (
          <p className="mt-2 break-all text-xs text-subtle">{String(r.model_path)}</p>
        )}
      </ResultBlock>
    );
  }

  if (task.task_type === "review") {
    const pass = r.pass as number | undefined;
    return (
      <ResultBlock title="审查结果">
        {pass != null && <StatRow label="机器通过" value={`${pass} 张`} />}
      </ResultBlock>
    );
  }

  // 兜底：键值展示，避免裸 JSON
  return (
    <ResultBlock title="结果摘要">
      {Object.entries(r).map(([k, v]) => (
        <StatRow
          key={k}
          label={k}
          value={typeof v === "object" ? JSON.stringify(v) : String(v)}
        />
      ))}
    </ResultBlock>
  );
}

const TRAINABLE_STATUSES = new Set(["human_ok", "no_target", "auto_ok", "auto_fixed"]);

function LabelSnapshot({ task }: { task: Task }) {
  const [stats, setStats] = useState<Record<string, number>>({});
  const [allFrames, setAllFrames] = useState<Frame[]>([]);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);

  useEffect(() => {
    if (!["export", "train"].includes(task.task_type) || task.status !== "completed") {
      setStats({});
      setAllFrames([]);
      return;
    }
    api.frameStats(task.project_id).then(setStats);
    api.listFrames(task.project_id, undefined, "recent", 0).then((frames) => {
      setAllFrames(frames.filter((f) => TRAINABLE_STATUSES.has(f.status)));
    });
  }, [task.id, task.task_type, task.status, task.project_id]);

  if (!["export", "train"].includes(task.task_type) || task.status !== "completed") return null;

  const trainable =
    (stats.human_ok ?? 0) +
    (stats.no_target ?? 0) +
    (stats.auto_ok ?? 0) +
    (stats.auto_fixed ?? 0);
  const withBoxEst = trainable - (stats.no_target ?? 0);

  if (trainable === 0) return null;

  const withBox = allFrames.filter((f) => f.annotations.length > 0);
  const samples = [
    ...withBox.slice(0, 3),
    ...allFrames.filter((f) => f.status === "no_target").slice(0, 1),
  ].slice(0, 4);

  const openLightbox = (frameId: string) => {
    const idx = allFrames.findIndex((f) => f.id === frameId);
    setLightboxIndex(idx >= 0 ? idx : 0);
    setLightboxOpen(true);
  };

  return (
    <>
      <ResultBlock title="标注概况">
        <div className="mb-3 grid grid-cols-2 gap-2 text-center text-sm">
          <div className="rounded bg-surface-soft px-2 py-2">
            <div className="text-lg font-semibold text-ink">{withBoxEst}</div>
            <div className="text-xs text-subtle">有标注框</div>
          </div>
          <div className="rounded bg-surface-soft px-2 py-2">
            <div className="text-lg font-semibold text-ink">{stats.no_target ?? 0}</div>
            <div className="text-xs text-subtle">无目标</div>
          </div>
        </div>
        {samples.length > 0 && (
          <>
            <p className="mb-2 text-xs text-subtle">抽样预览（点击可大图翻页查看全部）</p>
            <div className="grid grid-cols-4 gap-1.5">
              {samples.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => openLightbox(f.id)}
                  className="overflow-hidden rounded border border-border hover:border-brand-600"
                  title={f.filename}
                >
                  <img
                    src={api.frameImageUrl(task.project_id, f.id, true)}
                    alt={f.filename}
                    className="aspect-square w-full object-cover bg-black"
                  />
                </button>
              ))}
            </div>
            <div className="mt-2">
              {allFrames.length > 0 && (
                <button
                  type="button"
                  className="text-xs text-brand-600 hover:underline"
                  onClick={() => {
                    setLightboxIndex(0);
                    setLightboxOpen(true);
                  }}
                >
                  浏览全部 {allFrames.length} 张 →
                </button>
              )}
            </div>
          </>
        )}
      </ResultBlock>
      <FrameLightbox
        open={lightboxOpen}
        frames={allFrames}
        index={lightboxIndex}
        projectId={task.project_id}
        onClose={() => setLightboxOpen(false)}
        onIndexChange={setLightboxIndex}
      />
    </>
  );
}

export function TaskDetailPanel({ task, onCancel }: Props) {
  const pct = task.total > 0 ? Math.round((task.progress / task.total) * 100) : 0;
  const logLines = task.log ? formatLogLines(task.log) : [];

  return (
    <div className="text-sm">
      <div className="space-y-1">
        <p>
          <span className="text-muted">项目：</span>
          <Link href={`/projects/${task.project_id}`} className="text-brand-600 hover:underline">
            {task.projectName}
          </Link>
        </p>
        <p><span className="text-muted">类型：</span>{TASK_LABEL[task.task_type] || task.task_type}</p>
        <p>
          <span className="text-muted">状态：</span>
          <span className={
            task.status === "completed" ? "text-success-600" :
            task.status === "failed" ? "text-danger-600" :
            task.status === "running" ? "text-warning-600" : "text-text"
          }>
            {STATUS_ZH[task.status] || task.status}
          </span>
        </p>
        <p><span className="text-muted">时间：</span>{new Date(task.created_at).toLocaleString()}</p>
      </div>

      <div className="mt-4">
        <div className="mb-1 flex justify-between text-xs text-muted">
          <span>进度</span>
          <span>{task.progress} / {task.total}{task.total > 0 ? ` (${pct}%)` : ""}</span>
        </div>
        <div className="h-2 rounded bg-surface-soft">
          <div
            className={`h-2 rounded transition-all ${task.status === "failed" ? "bg-danger-600" : "bg-brand-600"}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      <TaskResultSummary task={task} />
      <LabelSnapshot task={task} />

      {logLines.length > 0 && !hideLogForTask(task) && (
        <ResultBlock title="执行日志">
          <ul className="space-y-1 text-xs text-muted">
            {logLines.map((line, i) => (
              <li key={i} className="break-all">{line}</li>
            ))}
          </ul>
        </ResultBlock>
      )}

      {task.error && (
        <div className="mt-4 rounded-lg border border-danger-600/30 bg-danger-50 px-3 py-2 text-sm text-danger-600">
          {task.error}
        </div>
      )}

      {task.status === "running" && onCancel && (
        <button type="button" className="btn-secondary mt-4" onClick={onCancel}>
          取消任务
        </button>
      )}
    </div>
  );
}
