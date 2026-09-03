"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { api, type AuditLog, type Project } from "@/lib/api";

const ACTION_LABEL: Record<string, string> = {
  "auth.login": "用户登录",
  "project.create": "创建项目",
  "project.update": "更新项目",
  "project.delete": "删除项目",
  "project.categories.update": "更新类别",
  "settings.update": "更新全局设置",
  "media.video.upload": "上传视频",
  "media.video.delete": "删除视频",
  "media.image.upload": "上传图片",
  "frame.annotate": "保存标注",
  "frame.feedback": "帧复核",
  "task.create": "创建任务",
  "task.cancel": "取消任务",
  "task.retry": "重试任务",
  "dataset.create": "创建数据集版本",
  "model.upload": "上传模型",
};

const PAGE_SIZE_OPTIONS = [10, 20, 50];

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function actionLabel(action: string) {
  return ACTION_LABEL[action] ?? action;
}

export default function AuditPage() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [total, setTotal] = useState(0);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [action, setAction] = useState("all");
  const [projectId, setProjectId] = useState("all");
  const [pageSize, setPageSize] = useState(20);
  const [page, setPage] = useState(1);

  const loadProjects = useCallback(async () => {
    try {
      const next = await api.listProjects();
      setProjects(next);
    } catch {
      setProjects([]);
    }
  }, []);

  const load = useCallback(async () => {
    setError("");
    try {
      const result = await api.listAuditLogs({
        page,
        page_size: pageSize,
        q: query.trim() || undefined,
        action: action === "all" ? undefined : action,
        project_id: projectId === "all" ? undefined : projectId,
      });
      setLogs(result.items);
      setTotal(result.total);
    } catch (err) {
      setLogs([]);
      setTotal(0);
      setError(err instanceof Error ? err.message : "加载审计日志失败");
    } finally {
      setLoading(false);
    }
  }, [action, page, pageSize, projectId, query]);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    setPage(1);
  }, [action, pageSize, projectId, query]);

  const actionOptions = useMemo(() => {
    const fromData = [...new Set(logs.map((item) => item.action))];
    const merged = new Set([...Object.keys(ACTION_LABEL), ...fromData]);
    return [...merged].sort();
  }, [logs]);

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, pageCount);
  const rangeStart = total ? (safePage - 1) * pageSize + 1 : 0;
  const rangeEnd = Math.min(safePage * pageSize, total);
  const activeFilterCount = [action, projectId].filter((value) => value !== "all").length + (query.trim() ? 1 : 0);

  return (
    <div className="audit-page">
      <section className="audit-overview" aria-label="审计日志概览">
        <div className="audit-overview__identity">
          <span className="audit-overview__mark"><Icon name="audit" size={26} /></span>
          <div>
            <span className="audit-overview__eyebrow">Workspace activity</span>
            <strong>{total.toLocaleString("zh-CN")}</strong>
            <p>条关键操作留痕</p>
          </div>
        </div>
        <div className="audit-overview__metrics">
          <article>
            <span><Icon name="users" size={18} /></span>
            <div><strong>{new Set(logs.map((item) => item.actor)).size}</strong><small>当前页操作者</small></div>
          </article>
          <article>
            <span><Icon name="folder" size={18} /></span>
            <div><strong>{projects.length}</strong><small>可筛选项目</small></div>
          </article>
          <article>
            <span><Icon name="sliders" size={18} /></span>
            <div><strong>{activeFilterCount}</strong><small>已启用筛选</small></div>
          </article>
        </div>
      </section>

      <section className="audit-workspace" aria-label="审计事件台账">
        <header className="audit-workspace__head">
          <div>
            <span className="audit-workspace__kicker">Event ledger</span>
            <h2>事件台账</h2>
          </div>
          <span className="audit-workspace__range">{rangeStart}–{rangeEnd} / {total}</span>
        </header>

        <div className="audit-toolbar" aria-label="审计日志筛选">
          <label className="audit-search">
            <Icon name="search" size={19} />
            <input
              aria-label="搜索审计日志"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索摘要、操作者或动作"
            />
          </label>
          <label className="audit-filter">
            <span>动作</span>
            <select aria-label="按动作筛选" value={action} onChange={(event) => setAction(event.target.value)}>
              <option value="all">全部动作</option>
              {actionOptions.map((value) => (
                <option key={value} value={value}>{actionLabel(value)}</option>
              ))}
            </select>
            <Icon name="chevron-down" size={15} />
          </label>
          <label className="audit-filter">
            <span>项目</span>
            <select aria-label="按项目筛选" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
              <option value="all">全部项目</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </select>
            <Icon name="chevron-down" size={15} />
          </label>
          <button
            type="button"
            className="audit-reset"
            disabled={activeFilterCount === 0}
            onClick={() => {
              setQuery("");
              setAction("all");
              setProjectId("all");
            }}
          >
            <Icon name="refresh" size={16} />
            重置
          </button>
        </div>

        <div className="audit-results" aria-live="polite">
        {loading ? (
          <div className="audit-skeleton" aria-label="正在加载审计日志">
            {Array.from({ length: 7 }, (_, index) => <span key={index} />)}
          </div>
        ) : error ? (
          <div className="task-results__empty">
            <Icon name="audit" size={28} />
            <strong>加载失败</strong>
            <span>{error}</span>
            <button type="button" className="btn-secondary" onClick={load}>重试</button>
          </div>
        ) : logs.length === 0 ? (
          <div className="task-results__empty">
            <Icon name="audit" size={28} />
            <strong>暂无审计记录</strong>
            <span>执行创建项目、上传素材或修改设置等操作后，将在此显示留痕。</span>
          </div>
        ) : (
          <>
            <div className="audit-list-head" aria-hidden="true">
              <span>时间</span>
              <span>操作者</span>
              <span>动作</span>
              <span>摘要</span>
              <span>项目</span>
            </div>
            <div className="audit-list">
              {logs.map((item) => (
                <article key={item.id} className="audit-row">
                  <time dateTime={item.created_at}>{formatDateTime(item.created_at)}</time>
                  <span className="audit-row__actor">{item.actor}</span>
                  <span className="audit-row__action">{actionLabel(item.action)}</span>
                  <span className="audit-row__summary" title={item.summary}>{item.summary}</span>
                  <span className="audit-row__project">
                    {item.project_id ? (
                      <Link href={`/projects/${item.project_id}`}>{item.project_name || "项目"}</Link>
                    ) : (
                      "—"
                    )}
                  </span>
                </article>
              ))}
            </div>
          </>
        )}
        </div>

        <footer className="audit-pagination">
          <span>显示 {rangeStart}–{rangeEnd} 条，共 {total} 条记录</span>
          <div>
          <label>
            <select aria-label="每页条数" value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))}>
              {PAGE_SIZE_OPTIONS.map((value) => (
                <option key={value} value={value}>{value} 条 / 页</option>
              ))}
            </select>
            <Icon name="chevron-down" size={15} />
          </label>
          <button type="button" aria-label="上一页" disabled={safePage === 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>
            <Icon name="chevron-left" size={17} />
          </button>
          <button type="button" className="active">{safePage}</button>
          {pageCount > 1 && safePage < pageCount && (
            <button type="button" onClick={() => setPage(pageCount)}>{pageCount}</button>
          )}
          <button type="button" aria-label="下一页" disabled={safePage === pageCount} onClick={() => setPage((value) => Math.min(pageCount, value + 1))}>
            <Icon name="chevron-right" size={17} />
          </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
