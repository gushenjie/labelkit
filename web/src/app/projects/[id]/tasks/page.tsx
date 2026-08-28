"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { api, Task } from "@/lib/api";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel, PanelSection } from "@/components/ui/Panel";
import { StatusBadge } from "@/components/ui/StatusBadge";

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
  public_fetch: "公开数据下载分析",
  public_import: "公开数据发布",
};

export default function TasksPage() {
  const { id } = useParams<{ id: string }>();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selected, setSelected] = useState<Task | null>(null);

  useEffect(() => {
    if (!id) return;
    const load = () => api.listTasks(id).then((nextTasks) => {
      setTasks(nextTasks);
      setSelected((current) => current ? nextTasks.find((task) => task.id === current.id) ?? current : null);
    });
    load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [id]);

  return (
    <div>
      <PageHeader title="任务中心" description="本项目的后台任务进度与历史" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel>
          <PanelSection title="任务历史">
          {tasks.length === 0 ? (
            <p className="text-sm text-subtle">暂无任务</p>
          ) : (
            <ul className="space-y-2">
              {tasks.map((t) => (
                <li
                  key={t.id}
                  className={`cursor-pointer rounded-lg border p-3 text-sm transition ${
                    selected?.id === t.id ? "border-brand-600 bg-brand-50" : "border-border hover:border-brand-100"
                  }`}
                  onClick={() => setSelected(t)}
                >
                  <div className="flex justify-between">
                    <span className="font-medium text-brand-600">{TASK_LABEL[t.task_type] || t.task_type}</span>
                    <StatusBadge status={t.status} />
                  </div>
                  <div className="mt-1 text-xs text-subtle">
                    {new Date(t.created_at).toLocaleString()} · {t.progress}/{t.total}
                  </div>
                </li>
              ))}
            </ul>
          )}
          </PanelSection>
        </Panel>
        <Panel>
          <PanelSection title="任务详情">
          {!selected ? (
            <p className="text-sm text-subtle">选择任务查看详情</p>
          ) : (
            <div className="text-sm">
              <p><span className="text-muted">类型:</span> {TASK_LABEL[selected.task_type] || selected.task_type}</p>
              <p><span className="text-muted">状态:</span> <StatusBadge status={selected.status} /></p>
              <p><span className="text-muted">进度:</span> {selected.progress}/{selected.total}</p>
              {selected.result && Object.keys(selected.result).length > 0 && (
                <pre className="mt-2 rounded bg-surface-soft p-2 text-xs">{JSON.stringify(selected.result, null, 2)}</pre>
              )}
              {selected.log && (
                <pre className="mt-2 max-h-64 overflow-auto rounded bg-surface-soft p-2 text-xs text-muted">{selected.log}</pre>
              )}
              {selected.error && <p className="mt-2 text-danger-600">{selected.error}</p>}
              {selected.status === "running" && id && (
                <button className="btn-secondary mt-3" disabled={selected.cancel_requested} onClick={() => api.cancelTask(id, selected.id)}>
                  {selected.cancel_requested ? "取消中…" : "取消任务"}
                </button>
              )}
              {["failed", "cancelled", "interrupted"].includes(selected.status) && id && (
                <button className="btn-secondary mt-3" onClick={() => api.retryTask(id, selected.id)}>创建重试任务</button>
              )}
              {selected.retry_of_task_id && <p className="mt-2 text-xs text-subtle">重试来源：{selected.retry_of_task_id}</p>}
            </div>
          )}
          </PanelSection>
        </Panel>
      </div>
    </div>
  );
}
