export type TrainProgressMode = "detect" | "classify";

export type TrainProgressRow = {
  epochCurrent: number;
  epochTotal: number;
  gpuMem: string;
  boxLoss?: number;
  clsLoss?: number;
  dflLoss?: number;
  loss?: number;
  instances: number;
  size: number;
  batchPercent?: number;
  batchCurrent?: number;
  batchTotal?: number;
  speed?: string;
  eta?: string;
};

export type TrainLogEntry =
  | { kind: "info"; text: string }
  | { kind: "error"; text: string }
  | { kind: "progress"; mode: TrainProgressMode; row: TrainProgressRow }
  | { kind: "raw"; text: string };

export type TrainLogBlock =
  | { kind: "text"; entry: Extract<TrainLogEntry, { kind: "info" | "error" | "raw" }> }
  | { kind: "progress-table"; mode: TrainProgressMode; rows: TrainProgressRow[] };

const DETECT_PROGRESS_RE =
  /^(\d+)\/(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\d+):\s*(\d+)%.*?(\d+)\/(\d+)(?:\s+([\d.]+s\/it))?(?:\s+([\d.]+s)?<(.+))?/;

const CLASSIFY_PROGRESS_RE =
  /^(\d+)\/(\d+)\s+(\S+)\s+([\d.]+)\s+(\d+)\s+(\d+):\s*(\d+)%.*?(\d+)\/(\d+)(?:\s+([\d.]+s\/it))?(?:\s+([\d.]+s)?<(.+))?/;

function parseBatchTail(tail: string) {
  const detect = tail.match(DETECT_PROGRESS_RE);
  if (detect) {
    return {
      mode: "detect" as const,
      row: {
        epochCurrent: Number(detect[1]),
        epochTotal: Number(detect[2]),
        gpuMem: detect[3],
        boxLoss: Number(detect[4]),
        clsLoss: Number(detect[5]),
        dflLoss: Number(detect[6]),
        instances: Number(detect[7]),
        size: Number(detect[8]),
        batchPercent: Number(detect[9]),
        batchCurrent: Number(detect[10]),
        batchTotal: Number(detect[11]),
        speed: detect[12] || undefined,
        eta: detect[14]?.trim() || undefined,
      },
    };
  }

  const classify = tail.match(CLASSIFY_PROGRESS_RE);
  if (classify) {
    return {
      mode: "classify" as const,
      row: {
        epochCurrent: Number(classify[1]),
        epochTotal: Number(classify[2]),
        gpuMem: classify[3],
        loss: Number(classify[4]),
        instances: Number(classify[5]),
        size: Number(classify[6]),
        batchPercent: Number(classify[7]),
        batchCurrent: Number(classify[8]),
        batchTotal: Number(classify[9]),
        speed: classify[10] || undefined,
        eta: classify[12]?.trim() || undefined,
      },
    };
  }

  return null;
}

export function parseTrainLogLine(line: string): TrainLogEntry {
  const text = line.trim();
  if (!text) return { kind: "raw", text: "" };

  if (text.startsWith("[ERROR]")) {
    return { kind: "error", text };
  }

  const progress = parseBatchTail(text);
  if (progress) {
    return { kind: "progress", mode: progress.mode, row: progress.row };
  }

  if (
    text.startsWith("检测数据集:")
    || text.startsWith("分类数据集:")
    || text.startsWith("训练数据量:")
    || text.startsWith("开始训练")
    || text.includes("训练已取消")
    || text.includes("任务已取消")
    || text.includes("用户请求停止")
  ) {
    return { kind: "info", text };
  }

  return { kind: "raw", text };
}

export function formatTrainLog(log: string, maxLines = 80): string[] {
  return log
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-maxLines);
}

export function parseTrainLogLines(lines: string[]): TrainLogEntry[] {
  return lines.map(parseTrainLogLine).filter((entry) => entry.kind !== "raw" || entry.text);
}

export function groupTrainLogEntries(entries: TrainLogEntry[]): TrainLogBlock[] {
  const blocks: TrainLogBlock[] = [];
  let buffer: TrainProgressRow[] = [];
  let bufferMode: TrainProgressMode = "detect";

  const flush = () => {
    if (!buffer.length) return;
    blocks.push({ kind: "progress-table", mode: bufferMode, rows: buffer });
    buffer = [];
  };

  for (const entry of entries) {
    if (entry.kind === "progress") {
      if (!buffer.length) bufferMode = entry.mode;
      buffer.push(entry.row);
      continue;
    }
    flush();
    blocks.push({ kind: "text", entry });
  }

  flush();
  return blocks;
}

export function formatDatasetInfo(text: string): string {
  const match = text.match(/^(检测数据集|分类数据集|训练数据量):\s*(\{.*\})$/);
  if (!match) return text;
  try {
    const payload = JSON.parse(match[2].replace(/'/g, '"')) as Record<string, number>;
    const parts = [
      payload.train != null ? `训练 ${payload.train}` : null,
      payload.val != null ? `验证 ${payload.val}` : null,
      payload.test != null ? `测试 ${payload.test}` : null,
      payload.total != null ? `合计 ${payload.total}` : null,
    ].filter(Boolean);
    return `${match[1]}：${parts.join(" · ")}`;
  } catch {
    return text;
  }
}
