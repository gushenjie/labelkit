import { describe, expect, it } from "vitest";
import { formatTrainLog, groupTrainLogEntries, parseTrainLogLine, parseTrainLogLines } from "./train-log";

describe("train-log parser", () => {
  it("parses YOLO detect progress lines with legacy speed/eta", () => {
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

  it("parses Ultralytics tqdm bracket speed/eta", () => {
    const entry = parseTrainLogLine(
      "50/50 3.29G 1.998 3.363 2.121 39 640: 2%|▏| 25/1093 [00:31<21:52, 1.23s/it]",
    );
    expect(entry.kind).toBe("progress");
    if (entry.kind !== "progress") return;
    expect(entry.row).toMatchObject({
      epochCurrent: 50,
      epochTotal: 50,
      gpuMem: "3.29G",
      batchCurrent: 25,
      batchTotal: 1093,
      batchPercent: 2,
      speed: "1.23s/it",
      eta: "21:52",
    });
  });

  it("parses it/s speed from tqdm brackets", () => {
    const entry = parseTrainLogLine(
      "1/80 1.2G 1.1 2.2 1.3 8 640: 10%|█| 5/50 [00:02<00:18, 2.45it/s]",
    );
    expect(entry.kind).toBe("progress");
    if (entry.kind !== "progress") return;
    expect(entry.row).toMatchObject({
      speed: "2.45it/s",
      eta: "00:18",
    });
  });

  it("keeps speed/eta empty when tqdm has not reported them yet", () => {
    const entry = parseTrainLogLine("1/80 0G 2.072 6.01 2.205 30 640: 0% ━━━━━ 0/53");
    expect(entry.kind).toBe("progress");
    if (entry.kind !== "progress") return;
    expect(entry.row.speed).toBeUndefined();
    expect(entry.row.eta).toBeUndefined();
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
      rows: [{ epochCurrent: 1 }, { epochCurrent: 1, batchCurrent: 1, speed: "5.0s/it", eta: "4:10" }],
    });
  });

  it("removes terminal control characters before displaying or copying logs", () => {
    expect(formatTrainLog("\u001b[K 1/80 0G 2.072 6.01 2.205 30 640: 2%\n")).toEqual([
      "1/80 0G 2.072 6.01 2.205 30 640: 2%",
    ]);
  });
});
