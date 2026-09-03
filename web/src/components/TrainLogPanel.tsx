"use client";

import { useEffect, useMemo, useRef } from "react";
import {
  formatDatasetInfo,
  groupTrainLogEntries,
  parseTrainLogLines,
  type TrainProgressMode,
  type TrainProgressRow,
} from "@/lib/train-log";

type Props = {
  lines: string[];
  emptyText: string;
};

const DETECT_COLUMNS: Array<{ key: keyof TrainProgressRow | "batch" | "epoch"; label: string }> = [
  { key: "epoch", label: "轮次" },
  { key: "gpuMem", label: "显存" },
  { key: "boxLoss", label: "Box损失" },
  { key: "clsLoss", label: "Cls损失" },
  { key: "dflLoss", label: "DFL损失" },
  { key: "instances", label: "目标数" },
  { key: "size", label: "输入尺寸" },
  { key: "batch", label: "批次进度" },
  { key: "speed", label: "速度" },
  { key: "eta", label: "剩余" },
];

const CLASSIFY_COLUMNS: Array<{ key: keyof TrainProgressRow | "batch" | "epoch"; label: string }> = [
  { key: "epoch", label: "轮次" },
  { key: "gpuMem", label: "显存" },
  { key: "loss", label: "损失" },
  { key: "instances", label: "样本数" },
  { key: "size", label: "输入尺寸" },
  { key: "batch", label: "批次进度" },
  { key: "speed", label: "速度" },
  { key: "eta", label: "剩余" },
];

function renderCell(row: TrainProgressRow, key: (typeof DETECT_COLUMNS)[number]["key"]) {
  if (key === "epoch") return `${row.epochCurrent}/${row.epochTotal}`;
  if (key === "batch") {
    if (row.batchCurrent == null || row.batchTotal == null) return "--";
    const percent = row.batchPercent != null ? ` · ${row.batchPercent}%` : "";
    return `${row.batchCurrent}/${row.batchTotal}${percent}`;
  }
  const value = row[key];
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : value.toFixed(3);
  }
  return value || "--";
}

function ProgressTable({ mode, rows }: { mode: TrainProgressMode; rows: TrainProgressRow[] }) {
  const columns = mode === "detect" ? DETECT_COLUMNS : CLASSIFY_COLUMNS;
  return (
    <div className="train-monitor__log-table-wrap">
      <table className="train-monitor__log-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key}>{column.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.epochCurrent}-${row.batchCurrent ?? 0}-${index}`}>
              {columns.map((column) => (
                <td key={column.key}>{renderCell(row, column.key)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TrainLogPanel({ lines, emptyText }: Props) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const blocks = useMemo(() => groupTrainLogEntries(parseTrainLogLines(lines)), [lines]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollTop = viewport.scrollHeight;
  }, [blocks.length, lines.length]);

  if (!lines.length) {
    return <div className="train-monitor__empty">{emptyText}</div>;
  }

  return (
    <div ref={viewportRef} className="train-monitor__log lk-scrollbar">
      {blocks.map((block, index) => {
        if (block.kind === "progress-table") {
          return <ProgressTable key={`table-${index}`} mode={block.mode} rows={block.rows} />;
        }

        const text = block.entry.kind === "info" ? formatDatasetInfo(block.entry.text) : block.entry.text;
        const className =
          block.entry.kind === "error"
            ? "train-monitor__log-line train-monitor__log-line--error"
            : block.entry.kind === "info"
              ? "train-monitor__log-line train-monitor__log-line--info"
              : "train-monitor__log-line train-monitor__log-line--raw";

        return (
          <p key={`text-${index}`} className={className}>
            {text}
          </p>
        );
      })}
    </div>
  );
}
