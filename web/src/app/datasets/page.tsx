"use client";

import Link from "next/link";
import { FormEvent, type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import {
  api,
  type DatasetCatalog,
  type DatasetVersionDetail,
  type DatasetVersionSummary,
  type Project,
} from "@/lib/api";

const EMPTY_CATALOG: DatasetCatalog = {
  total_versions: 0,
  project_count: 0,
  snapshot_sample_count: 0,
  linked_model_count: 0,
  total: 0,
  items: [],
};
const PAGE_SIZE = 10;

function number(value: number) {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function date(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "--";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).format(parsed);
}

function taskLabel(value: string) {
  return value === "classify" ? "图像分类" : "目标检测";
}

function annotationStatusLabel(value: string) {
  const labels: Record<string, string> = {
    human_ok: "人工确认",
    no_target: "无目标",
    unlabeled: "未标注",
    pending: "待确认",
  };
  return labels[value] ?? value;
}

function linkedTaskLabel(value: string) {
  const labels: Record<string, string> = {
    train: "模型训练",
    dataset_snapshot: "创建数据版本",
    export: "导出数据版本",
  };
  return labels[value] ?? value;
}

function taskStatusLabel(value: string) {
  const labels: Record<string, string> = {
    completed: "已完成",
    pending: "等待执行",
    running: "执行中",
    failed: "执行失败",
    cancelled: "已取消",
    interrupted: "已中断",
  };
  return labels[value] ?? value;
}

export default function DatasetCenterPage() {
  const [catalog, setCatalog] = useState(EMPTY_CATALOG);
  const [projects, setProjects] = useState<Project[]>([]);
  const [query, setQuery] = useState("");
  const [projectId, setProjectId] = useState("");
  const [taskType, setTaskType] = useState("");
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<DatasetVersionSummary | null>(null);
  const [detail, setDetail] = useState<DatasetVersionDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const next = await api.getDatasetCatalog({
        projectId,
        query: query.trim(),
        taskType,
        offset: page * PAGE_SIZE,
        limit: PAGE_SIZE,
      });
      setCatalog(next);
      setSelected((current) => {
        if (current && next.items.some((item) => item.id === current.id)) return current;
        return next.items[0] ?? null;
      });
    } catch (nextError) {
      setError(String(nextError));
    } finally {
      setLoading(false);
    }
  }, [page, projectId, query, taskType]);

  useEffect(() => {
    api.listProjects().then(setProjects).catch(() => setProjects([]));
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(load, 180);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    const open = () => setCreateOpen(true);
    window.addEventListener("open-create-dataset-version", open);
    return () => window.removeEventListener("open-create-dataset-version", open);
  }, []);

  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    let active = true;
    setDetailLoading(true);
    api.getDatasetVersionDetail(selected.project_id, selected.id)
      .then((next) => { if (active) setDetail(next); })
      .catch(() => { if (active) setDetail(null); })
      .finally(() => { if (active) setDetailLoading(false); });
    return () => { active = false; };
  }, [selected]);

  useEffect(() => setPage(0), [projectId, query, taskType]);
  const pageCount = Math.max(1, Math.ceil(catalog.total / PAGE_SIZE));

  return (
    <div className="dataset-center-page">
      <section className="dataset-metrics" aria-label="数据集概览">
        <Metric icon="database" value={catalog.total_versions} label="数据集总数" unit="个数据集" hint="当前工作区" />
        <Metric icon="archive" value={catalog.project_count} label="覆盖项目" unit="个项目" hint="包含历史版本" />
        <Metric icon="layers" value={catalog.snapshot_sample_count} label="样本总数" unit="张图片" hint="跨版本累计" />
        <Metric icon="package" value={catalog.linked_model_count} label="关联模型" unit="个模型" hint="训练来源可追溯" />
      </section>

      <section className="dataset-toolbar" aria-label="数据集筛选">
        <label className="dataset-search">
          <Icon name="search" size={18} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索数据集、版本或标签（ID）" />
        </label>
        <label className="dataset-filter">
          <select aria-label="按项目筛选" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            <option value="">全部分组</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
          <Icon name="chevron-down" size={14} />
        </label>
        <label className="dataset-filter">
          <select aria-label="按任务类型筛选" value={taskType} onChange={(event) => setTaskType(event.target.value)}>
            <option value="">全部类型</option>
            <option value="detect">目标检测</option>
            <option value="classify">图像分类</option>
          </select>
          <Icon name="chevron-down" size={14} />
        </label>
        <button className="dataset-filter-button" type="button" onClick={load}><Icon name="sliders" size={16} />筛选</button>
        {(query || projectId || taskType) && (
          <button className="dataset-reset" type="button" onClick={() => { setQuery(""); setProjectId(""); setTaskType(""); }}>
            清除筛选
          </button>
        )}
      </section>

      <div className="dataset-workspace">
        <section className="dataset-list-panel" aria-label="数据版本列表">
          <div className="dataset-list-body" aria-live="polite">
            {loading ? <DatasetSkeleton /> : error ? (
              <div className="dataset-state dataset-state--error"><Icon name="audit" size={28} /><strong>数据版本加载失败</strong><p>{error}</p><button type="button" className="btn-secondary" onClick={load}>重试</button></div>
            ) : catalog.items.length === 0 ? (
              <div className="dataset-state"><Icon name="database" size={30} /><strong>{catalog.total_versions ? "没有符合条件的数据版本" : "还没有数据版本"}</strong><p>{catalog.total_versions ? "调整筛选条件后再试。" : "将已确认标注固化为可复现的训练快照。"}</p><button type="button" className="btn-primary" onClick={() => {
                if (!catalog.total_versions) {
                  setCreateOpen(true);
                  return;
                }
                setQuery("");
                setProjectId("");
                setTaskType("");
              }}>{catalog.total_versions ? "清除筛选" : "创建首个版本"}</button></div>
            ) : catalog.items.map((item) => (
              <DatasetRow key={item.id} item={item} active={detailOpen && selected?.id === item.id} onSelect={() => { setSelected(item); setDetailOpen(true); }} />
            ))}
          </div>
          <footer className="dataset-pagination">
            <span>共 {number(catalog.total)} 个数据集</span>
            <div><button type="button" aria-label="上一页" disabled={page === 0} onClick={() => setPage((value) => Math.max(0, value - 1))}><Icon name="chevron-left" size={16} /></button><b>{page + 1}</b><button type="button" aria-label="下一页" disabled={page + 1 >= pageCount} onClick={() => setPage((value) => value + 1)}><Icon name="chevron-right" size={16} /></button><span className="dataset-page-size">10 条/页<Icon name="chevron-down" size={13} /></span></div>
          </footer>
        </section>

      </div>

      <p className="dataset-retention-note"><Icon name="lock" size={14} />版本内容在项目存续期间不可编辑；删除项目会一并删除其数据版本、模型和快照文件。</p>
      {detailOpen && <DatasetDetailDrawer summary={selected} detail={detail} loading={detailLoading} onClose={() => setDetailOpen(false)} />}
      {createOpen && <CreateDatasetDialog projects={projects} onClose={() => setCreateOpen(false)} onCreated={async (project, versionId) => { setCreateOpen(false); setProjectId(project); setQuery(""); setTaskType(""); setPage(0); const next = await api.getDatasetCatalog({ projectId: project, limit: PAGE_SIZE }); setCatalog(next); const found = next.items.find((item) => item.id === versionId); if (found) setSelected(found); }} />}
    </div>
  );
}

function Metric({ icon, value, label, unit, hint }: { icon: "database" | "archive" | "layers" | "package"; value: number; label: string; unit: string; hint: string }) {
  return <article><span><Icon name={icon} size={30} /></span><div><p>{label}</p><strong>{number(value)}</strong><small>{unit}</small><em>{hint}</em></div></article>;
}

function SplitBar({ item }: { item: DatasetVersionSummary }) {
  const total = Math.max(1, item.sample_count);
  return <div className="dataset-split" aria-label={`训练 ${item.train_count}，验证 ${item.val_count}，测试 ${item.test_count}`}><div><i className="train" style={{ width: `${item.train_count / total * 100}%` }} /><i className="val" style={{ width: `${item.val_count / total * 100}%` }} /><i className="test" style={{ width: `${item.test_count / total * 100}%` }} /></div><small>训练 {number(item.train_count)} · 验证 {number(item.val_count)}{item.test_count ? ` · 测试 ${number(item.test_count)}` : ""}</small></div>;
}

function DatasetRow({ item, active, onSelect }: { item: DatasetVersionSummary; active: boolean; onSelect: () => void }) {
  const created = date(item.created_at).split(" ");
  return <article role="button" tabIndex={0} className={`dataset-row ${active ? "dataset-row--active" : ""}`} onClick={onSelect} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(); } }} aria-pressed={active}>
    <span className="dataset-row__glyph"><Icon name={item.task_type === "classify" ? "grid" : "image"} size={24} /></span>
    <span className="dataset-row__identity"><span><b>{item.project_name}</b><mark>v{item.version}.0.0</mark></span><small><i>{taskLabel(item.task_type)}</i><i>{item.source_group_count} 个来源组</i></small></span>
    <button type="button" className="dataset-row__more" aria-label="更多操作" onClick={(event) => { event.stopPropagation(); onSelect(); }}><Icon name="more" size={17} /></button>
    <DatasetCardSplit item={item} />
    <span className="dataset-row__classes"><small>类别数</small><b>{item.class_count}</b><em>{taskLabel(item.task_type)} / {item.source_group_count} 个来源组</em></span>
    <span className="dataset-row__date"><small>更新时间</small><b>{created[0]} {created.slice(1).join(" ")}</b><em>{item.linked_model_count ? `已关联 ${item.linked_model_count} 个模型` : "尚未关联模型"}</em></span>
  </article>;
}

function DatasetCardSplit({ item }: { item: DatasetVersionSummary }) {
  const total = Math.max(1, item.sample_count);
  const segments = [
    { label: "训练", count: item.train_count, className: "train" },
    { label: "验证", count: item.val_count, className: "val" },
    { label: "测试", count: item.test_count, className: "test" },
  ];
  return <span className="dataset-row__split"><small>数据集划分</small><span className="dataset-row__split-bar">{segments.map((segment) => <i key={segment.label} className={segment.className} style={{ width: `${segment.count / total * 100}%` }} />)}</span><span className="dataset-row__split-labels">{segments.map((segment) => <span key={segment.label}><small>{segment.label} {Math.round(segment.count / total * 100)}%</small><b>{number(segment.count)}</b></span>)}</span></span>;
}

function DatasetDetailDrawer({ summary, detail, loading, onClose }: { summary: DatasetVersionSummary | null; detail: DatasetVersionDetail | null; loading: boolean; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return <div className="dataset-detail-drawer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <DatasetDetailPanel summary={summary} detail={detail} loading={loading} onClose={onClose} closeRef={closeRef} />
  </div>;
}

function DatasetDetailPanel({ summary, detail, loading, onClose, closeRef }: { summary: DatasetVersionSummary | null; detail: DatasetVersionDetail | null; loading: boolean; onClose?: () => void; closeRef?: RefObject<HTMLButtonElement | null> }) {
  if (!summary) return <aside className="dataset-detail dataset-detail--empty"><Icon name="database" size={34} /><strong>选择一个数据版本</strong><p>查看固定划分、类别、任务和模型血缘。</p></aside>;
  return <aside className="dataset-detail dataset-detail--drawer" role="dialog" aria-modal="true" aria-labelledby="dataset-detail-title">
    <header><div className="dataset-detail__identity"><span className="dataset-detail__glyph"><Icon name="database" size={20} /></span><div><span>数据版本快照</span><h2 id="dataset-detail-title">数据集 v{summary.version}</h2><p>{summary.project_name}</p></div></div><div className="dataset-detail__header-actions"><mark><i />就绪</mark>{onClose && <button ref={closeRef} type="button" className="dataset-detail__close" aria-label="关闭版本详情" onClick={onClose}><Icon name="x" size={17} /></button>}</div></header>
    <SplitBar item={summary} />
    <dl className="dataset-detail__facts"><div><dt>样本</dt><dd>{number(summary.sample_count)}</dd></div><div><dt>类别</dt><dd>{summary.class_count}</dd></div><div><dt>来源组</dt><dd>{summary.source_group_count}</dd></div><div><dt>关联模型</dt><dd>{summary.linked_model_count}</dd></div></dl>
    {loading ? <div className="dataset-detail__loading">正在加载版本血缘…</div> : detail && <>
      <section><h3>类别快照</h3><div className="dataset-category-list">{detail.categories.map((category) => <span key={category.class_id}><i>类别 {category.class_id}</i><b>{category.name}</b></span>)}</div></section>
      <section><h3>标注状态组成</h3><div className="dataset-status-list">{Object.entries(detail.status_counts).map(([status, count]) => <span key={status}><b>{number(count)}</b><small>{annotationStatusLabel(status)}</small></span>)}</div></section>
      <section><h3>关联记录</h3>{detail.linked_models.length || detail.linked_tasks.length ? <ul className="dataset-lineage-list">{detail.linked_models.map((model) => <li key={`model-${model.id}`}><Icon name="package" size={15} /><span><b>模型：{model.name}</b><small>版本 {model.version} · {date(model.created_at)}</small></span></li>)}{detail.linked_tasks.slice(0, 5).map((task) => <li key={`task-${task.id}`}><Icon name="archive" size={15} /><span><b>{linkedTaskLabel(task.task_type)}</b><small>{taskStatusLabel(task.status)} · {date(task.created_at)}</small></span></li>)}</ul> : <p className="dataset-detail__muted">该版本尚未被训练或导出任务引用。</p>}</section>
      {detail.trigger_sources.length > 0 && <section><h3>触发来源 <small>不代表完整样本血缘</small></h3><ul className="dataset-source-list">{detail.trigger_sources.map((source, index) => <li key={`${source.provider}-${index}`}><b>{source.provider}</b><span>{source.title}</span></li>)}</ul></section>}
    </>}
    <section className="dataset-checksum"><h3>内容校验值</h3><code title={summary.checksum}>{summary.checksum}</code><p>训练和导出前会逐文件校验；检测到字节变化时拒绝继续。</p></section>
    <footer><Link className="btn-primary" href={`/projects/${summary.project_id}/train?datasetVersion=${summary.id}`}><Icon name="play" size={15} />用于训练</Link><Link className="btn-secondary" href={`/projects/${summary.project_id}/train?datasetVersion=${summary.id}#dataset-export`}>导出该版本</Link><Link className="dataset-project-link" href={`/projects/${summary.project_id}/review`}>查看当前项目素材</Link></footer>
  </aside>;
}

function DatasetSkeleton() {
  return <div className="dataset-skeleton" aria-label="正在加载数据版本">{Array.from({ length: 6 }, (_, index) => <span key={index} />)}</div>;
}

function CreateDatasetDialog({ projects, onClose, onCreated }: { projects: Project[]; onClose: () => void; onCreated: (projectId: string, versionId: string) => void }) {
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [valRatio, setValRatio] = useState(20);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);
  const selectedProject = useMemo(() => projects.find((project) => project.id === projectId), [projectId, projects]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) onClose();
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>("button:not(:disabled), select:not(:disabled), input:not(:disabled)"));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose, submitting]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!projectId || valRatio < 5 || valRatio > 50 || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const task = await api.createTask(projectId, "dataset_snapshot", { val_ratio: valRatio / 100 });
      let current = task;
      while (!["completed", "failed", "cancelled", "interrupted"].includes(current.status)) {
        await new Promise((resolve) => window.setTimeout(resolve, 700));
        current = await api.getTask(projectId, task.id);
      }
      if (current.status !== "completed") throw new Error(current.error || "数据版本创建未完成");
      const versionId = String(current.result?.dataset_version_id || "");
      if (!versionId) throw new Error("任务完成但未返回数据版本 ID");
      await onCreated(projectId, versionId);
    } catch (nextError) {
      setError(String(nextError));
      setSubmitting(false);
    }
  };

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !submitting) onClose(); }}>
    <div className="dataset-create-dialog" role="dialog" aria-modal="true" aria-labelledby="create-dataset-title" ref={panelRef}>
      <header><span><Icon name="database" size={20} /></span><div><h2 id="create-dataset-title">创建数据集</h2><p>将当前已确认标注固化为不可编辑的训练快照</p></div><button type="button" aria-label="关闭" disabled={submitting} onClick={onClose}><Icon name="x" size={18} /></button></header>
      <form onSubmit={submit}>
        <div className="dataset-create-body">
          <label><span>项目 <em>必选</em></span><select className="input" autoFocus value={projectId} onChange={(event) => setProjectId(event.target.value)} disabled={submitting}><option value="">请选择项目</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
          <label><span>验证集比例 <em>5%–50%</em></span><div className="dataset-ratio-input"><input className="input" type="number" min={5} max={50} value={valRatio} onChange={(event) => setValRatio(Number(event.target.value))} disabled={submitting} /><b>%</b></div></label>
          <div className="dataset-create-preview"><Icon name="layers" size={18} /><div><strong>{selectedProject?.name || "等待选择项目"}</strong><p>系统按来源组划分训练集和验证集，避免相邻视频帧跨集合泄漏。</p></div></div>
          <p className="dataset-create-warning"><Icon name="lock" size={14} />创建后内容不能编辑；需要变更标签时请创建新版本。</p>
          {error && <div className="dataset-create-error" role="alert">{error}</div>}
        </div>
        <footer><span>{submitting ? "正在生成并校验快照…" : "版本创建将占用当前项目的任务执行位"}</span><button type="button" className="btn-secondary" disabled={submitting} onClick={onClose}>取消</button><button type="submit" className="btn-primary" disabled={!projectId || valRatio < 5 || valRatio > 50 || submitting}>{submitting ? "创建中…" : "创建版本"}</button></footer>
      </form>
    </div>
  </div>;
}
