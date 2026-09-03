import { describe, expect, it } from "vitest";
import { groupTrainLogEntries, parseTrainLogLine, parseTrainLogLines } from "./train-log";

describe("train-log parser", () => {
  it("parses YOLO detect progress lines", () => {
    const entry = parseTrainLogLine("1/80 0G 2.072 6.01 2.205 30 640: 2% ━━━━━ 1/55 2.3s/it 2.2s<2:05");
    expect(entry.kind).toBe("progress");
    if (entry.kind !== "progress") return;
    expect(entry.mode).toBe("detect");
    expect(entry.row).toMatchObject({
      epochCurrent: 1,
      epochTotal: 80,
      gpuMem: "0G",
      boxLoss: 2.072,
      clsLoss: 6.01,
      dflLoss: 2.205,
      instances: 30,
      size: 640,
      batchPercent: 2,
      batchCurrent: 1,
      batchTotal: 55,
      speed: "2.3s/it",
      eta: "2:05",
    });
  });

  it("parses dataset info and groups progress rows into a table block", () => {
    const entries = parseTrainLogLines([
      "检测数据集: {'train': 419, 'val': 120, 'test': 40, 'total': 599}",
      "开始训练...",
      "1/80 0G 2.072 6.01 2.205 30 640: 0% ━━━━━ 0/53",
      "1/80 0G 2.505 6.582 2.157 20 640: 1% ━━━━━ 1/53 5.0s/it 2.9s<4:10",
    ]);
    const blocks = groupTrainLogEntries(entries);
    expect(blocks).toHaveLength(3);
    expect(blocks[0].kind).toBe("text");
    expect(blocks[1].kind).toBe("text");
    expect(blocks[2]).toMatchObject({
      kind: "progress-table",
      mode: "detect",
      rows: [{ epochCurrent: 1 }, { epochCurrent: 1, batchCurrent: 1 }],
    });
  });
});
