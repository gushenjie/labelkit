"use client";

import { useState } from "react";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/ToastProvider";
import { TaskProgress } from "@/components/ui/TaskProgress";
import { StatStrip } from "@/components/ui/StatStrip";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Select } from "@/components/ui/Select";
import { ListSkeleton } from "@/components/ui/ListSkeleton";

/** Development-only fixtures: reuse production components, never call business APIs. */
export function InteractionSamples() {
  const confirm = useConfirm();
  const { toast } = useToast();
  const [count, setCount] = useState(0);
  const [view, setView] = useState("materials");
  const [model, setModel] = useState("all");
  const [progress, setProgress] = useState(30);
  const ask = async () => { if (await confirm({ title: "确认操作样例", message: "仅记录确认次数，不操作业务数据。" })) setCount(value => value + 1); };
  return <div className="card" style={{ display: "grid", gap: 20, maxWidth: 760, margin: "24px auto", padding: 24 }}>
    <h1>UX 交互验证样例</h1>
    <p>开发环境 · 公共组件回归</p>
    <StatStrip items={[{ label: "确认次数", value: count }]} />
    <div style={{ display: "flex", gap: 8 }}><button className="btn-secondary" onClick={() => void ask()}>打开确认</button><button className="btn-secondary" onClick={() => toast({ type: "success", message: "操作已完成", action: { label: "记录", onClick: () => setCount(value => value + 1) } })}>显示通知</button></div>
    <SegmentedControl value={view} onChange={setView} options={[{ value: "materials", label: "素材" }, { value: "review", label: "复查" }, { value: "training", label: "训练" }]} />
    <Select ariaLabel="模型筛选样例" value={model} onValueChange={setModel} options={[{ value: "all", label: "全部模型" }, { value: "detection", label: "目标检测" }, { value: "disabled", label: "不可用模型", disabled: true }]} />
    <TaskProgress progress={progress} total={100} label="训练进度" />
    <button className="btn-secondary" onClick={() => setProgress(value => value === 30 ? 70 : 30)}>更新进度</button>
    <ListSkeleton count={2} variant="grid" />
  </div>;
}
