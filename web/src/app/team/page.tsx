"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/PageHeader";
import { useToast } from "@/components/ui/ToastProvider";
import { api, type WorkspaceUser } from "@/lib/api";
import { getAuthProfile } from "@/lib/auth";

const ROLE_OPTIONS: Array<{ value: WorkspaceUser["role"]; label: string }> = [
  { value: "admin", label: "管理员" },
  { value: "annotator", label: "标注员" },
  { value: "reviewer", label: "审核员" },
  { value: "viewer", label: "只读" },
];

const ROLE_LABELS = Object.fromEntries(ROLE_OPTIONS.map((item) => [item.value, item.label])) as Record<
  WorkspaceUser["role"],
  string
>;

type MemberFormState = {
  display_name: string;
  username: string;
  password: string;
  role: WorkspaceUser["role"];
  status: WorkspaceUser["status"];
};

const EMPTY_FORM: MemberFormState = {
  display_name: "",
  username: "",
  password: "",
  role: "annotator",
  status: "active",
};

function randomPassword(length = 10) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

function formatDateTime(value: string | null) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export default function TeamPage() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [members, setMembers] = useState<WorkspaceUser[]>([]);
  const [summary, setSummary] = useState({ total: 0, active: 0, admins: 0 });
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<WorkspaceUser | null>(null);
  const [form, setForm] = useState<MemberFormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    api.getAuthSession()
      .then((session) => setIsAdmin(session.role === "admin"))
      .catch(() => setIsAdmin(getAuthProfile()?.role === "admin"));
  }, []);

  const load = useCallback(async () => {
    if (!isAdmin) {
      setLoading(false);
      return;
    }
    try {
      const response = await api.listUsers({
        q: query.trim() || undefined,
        role: roleFilter === "all" ? undefined : roleFilter,
        status: statusFilter === "all" ? undefined : statusFilter,
      });
      setMembers(response.items);
      setSummary(response.summary);
    } catch (error) {
      toast({
        type: "error",
        message: error instanceof Error ? error.message : "加载成员列表失败",
      });
    } finally {
      setLoading(false);
    }
  }, [isAdmin, query, roleFilter, statusFilter, toast]);

  useEffect(() => {
    setLoading(true);
    const timer = window.setTimeout(() => {
      void load();
    }, 200);
    return () => window.clearTimeout(timer);
  }, [load]);

  const adminCount = useMemo(
    () => members.filter((member) => member.role === "admin" && member.status === "active").length,
    [members],
  );
  const formReady = Boolean(
    form.display_name.trim()
      && (editing || (form.username.trim() && form.password.trim())),
  );

  const openCreate = () => {
    setEditing(null);
    setForm({ ...EMPTY_FORM, password: randomPassword() });
    setModalOpen(true);
  };

  const openEdit = (member: WorkspaceUser) => {
    setEditing(member);
    setForm({
      display_name: member.display_name,
      username: member.username,
      password: "",
      role: member.role,
      status: member.status,
    });
    setModalOpen(true);
  };

  const closeModal = () => {
    setModalOpen(false);
    setEditing(null);
    setForm(EMPTY_FORM);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!isAdmin) return;
    setSaving(true);
    try {
      if (editing) {
        await api.updateUser(editing.id, {
          display_name: form.display_name,
          role: form.role,
          status: form.status,
          ...(form.password ? { password: form.password } : {}),
        });
        toast({ type: "success", message: "成员信息已更新" });
      } else {
        await api.createUser({
          username: form.username,
          display_name: form.display_name,
          password: form.password,
          role: form.role,
        });
        toast({ type: "success", message: "成员已创建" });
      }
      closeModal();
      await load();
    } catch (error) {
      toast({
        type: "error",
        message: error instanceof Error ? error.message : "保存成员失败",
      });
    } finally {
      setSaving(false);
    }
  };

  const toggleStatus = async (member: WorkspaceUser) => {
    if (!isAdmin) return;
    const nextStatus = member.status === "active" ? "disabled" : "active";
    if (member.role === "admin" && nextStatus === "disabled" && adminCount <= 1) {
      toast({ type: "error", message: "不能禁用最后一个管理员" });
      return;
    }
    try {
      await api.updateUser(member.id, { status: nextStatus });
      toast({ type: "success", message: nextStatus === "disabled" ? "成员已禁用" : "成员已启用" });
      await load();
    } catch (error) {
      toast({
        type: "error",
        message: error instanceof Error ? error.message : "更新成员状态失败",
      });
    }
  };

  const removeMember = async (member: WorkspaceUser) => {
    if (!isAdmin) return;
    if (member.role === "admin" && adminCount <= 1) {
      toast({ type: "error", message: "不能删除最后一个管理员" });
      return;
    }
    if (!window.confirm(`确定删除成员「${member.display_name}」吗？`)) return;
    try {
      await api.deleteUser(member.id);
      toast({ type: "success", message: "成员已删除" });
      await load();
    } catch (error) {
      toast({
        type: "error",
        message: error instanceof Error ? error.message : "删除成员失败",
      });
    }
  };

  if (!isAdmin) {
    return (
      <div className="operations-page team-page">
        <PageHeader
          title="团队与成员"
          description="管理工作区成员账号、角色与登录状态"
          eyebrow="Workspace members"
        />
        <div className="team-readonly">
          当前账号没有成员管理权限。如需添加或调整成员，请使用管理员账号登录。
        </div>
      </div>
    );
  }

  return (
    <div className="operations-page team-page">
      <PageHeader
        title="团队与成员"
        description="管理工作区成员账号、角色与登录状态"
        eyebrow="Workspace members"
        action={
          <button type="button" className="btn-primary" onClick={openCreate}>
            <Icon name="plus" size={16} />
            添加成员
          </button>
        }
      />

      <section className="team-overview" aria-label="成员概览">
        <div className="team-overview__lead">
          <span className="team-overview__icon" aria-hidden="true">
            <Icon name="users" size={22} />
          </span>
          <div>
            <span className="team-overview__kicker">Workspace overview</span>
            <h2>成员概览</h2>
            <p>当前有 {summary.active} 位成员处于活跃状态</p>
          </div>
        </div>
        <div className="team-metrics">
          <article className="team-metric team-metric--primary">
            <span>成员总数</span>
            <strong>{summary.total}</strong>
          </article>
          <article className="team-metric">
            <span>活跃成员</span>
            <strong>{summary.active}</strong>
          </article>
          <article className="team-metric">
            <span>管理员</span>
            <strong>{summary.admins}</strong>
          </article>
        </div>
      </section>

      <section className="team-directory" aria-label="成员台账">
        <header className="team-directory__header">
          <div>
            <h2>成员台账</h2>
            <p>检索成员并管理其角色与账号状态</p>
          </div>
          <span className="team-result-count">{loading ? "正在同步" : `${members.length} 位成员`}</span>
        </header>

        <div className="team-toolbar" aria-label="成员筛选">
          <label className="team-search">
            <Icon name="search" size={18} />
            <input
              aria-label="搜索成员"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索成员姓名或登录名"
            />
          </label>
          <label className="team-filter">
            <span>角色</span>
            <select aria-label="按角色筛选" value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)}>
              <option value="all">全部角色</option>
              {ROLE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="team-filter">
            <span>状态</span>
            <select aria-label="按状态筛选" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
              <option value="all">全部状态</option>
              <option value="active">活跃</option>
              <option value="disabled">已禁用</option>
            </select>
          </label>
        </div>

        <div className="team-panel" aria-live="polite" aria-busy={loading}>
          {loading ? (
            <div className="team-loading" aria-label="正在加载成员列表">
              {Array.from({ length: 3 }, (_, index) => (
                <span key={index} className="team-loading__row" />
              ))}
            </div>
          ) : members.length === 0 ? (
            <EmptyState
              title="没有找到成员"
              description={query || roleFilter !== "all" || statusFilter !== "all"
                ? "调整搜索词或筛选条件后再试。"
                : "添加标注员、审核员或只读账号，让团队一起使用这个平台。"}
              action={query || roleFilter !== "all" || statusFilter !== "all" ? undefined : (
                <button type="button" className="btn-primary" onClick={openCreate}>
                  添加第一个成员
                </button>
              )}
            />
          ) : (
            <>
              <div className="team-table-head" aria-hidden="true">
                <span>成员</span>
                <span>登录名</span>
                <span>角色</span>
                <span>状态</span>
                <span>最近登录</span>
                <span>操作</span>
              </div>
              {members.map((member) => (
                <div key={member.id} className="team-row">
                  <div className="team-member">
                    <span className="team-member__avatar" aria-hidden="true">
                      {(member.display_name || member.username).slice(0, 1).toUpperCase()}
                    </span>
                    <span className="team-member__copy">
                      <strong>{member.display_name}</strong>
                      <small>创建于 {formatDateTime(member.created_at)}</small>
                    </span>
                  </div>
                  <span className="team-cell" data-label="登录名">{member.username}</span>
                  <span className="team-cell" data-label="角色">
                    <span className={`team-role team-role--${member.role}`}>{ROLE_LABELS[member.role]}</span>
                  </span>
                  <span className="team-cell" data-label="状态">
                    <span className={member.status === "disabled" ? "team-status team-status--disabled" : "team-status"}>
                      <i aria-hidden="true" />
                      {member.status === "active" ? "活跃" : "已禁用"}
                    </span>
                  </span>
                  <span className="team-cell team-last-login" data-label="最近登录">
                    {member.last_login_at ? formatDateTime(member.last_login_at) : "尚未登录"}
                  </span>
                  <div className="team-actions" data-label="操作">
                    <button type="button" onClick={() => openEdit(member)}>
                      编辑
                    </button>
                    <button type="button" onClick={() => toggleStatus(member)}>
                      {member.status === "active" ? "禁用" : "启用"}
                    </button>
                    <button type="button" className="danger" onClick={() => removeMember(member)}>
                      删除
                    </button>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </section>

      {modalOpen && (
        <div className="team-modal-backdrop" role="presentation" onClick={closeModal}>
          <div
            className="team-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="team-modal-title"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="team-modal__header">
              <div>
                <span className="team-modal__eyebrow">Member account</span>
                <h2 id="team-modal-title">{editing ? "编辑成员" : "添加成员"}</h2>
                <p>{editing ? "更新显示名称、角色或重置密码。" : "创建新的工作区登录账号。"}</p>
              </div>
              <button type="button" className="team-modal__close" aria-label="关闭" onClick={closeModal} disabled={saving}>
                <Icon name="x" size={18} />
              </button>
            </header>
            <form onSubmit={handleSubmit}>
              <div className="team-modal__body">
                <label className="team-field" htmlFor="team-display-name">
                  <span>显示名称</span>
                  <input
                    id="team-display-name"
                    required
                    value={form.display_name}
                    onChange={(event) => setForm((current) => ({ ...current, display_name: event.target.value }))}
                  />
                </label>
                <label className="team-field" htmlFor="team-username">
                  <span>登录名</span>
                  <input
                    id="team-username"
                    required
                    disabled={Boolean(editing)}
                    value={form.username}
                    onChange={(event) => setForm((current) => ({ ...current, username: event.target.value }))}
                  />
                </label>
                <label className="team-field" htmlFor="team-password">
                  <span>{editing ? "新密码（留空则不修改）" : "初始密码"}</span>
                  <div className="team-password-row">
                    <input
                      id="team-password"
                      required={!editing}
                      value={form.password}
                      onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))}
                    />
                    <button
                      type="button"
                      onClick={() => setForm((current) => ({ ...current, password: randomPassword() }))}
                    >
                      生成
                    </button>
                  </div>
                </label>
                <label className="team-field">
                  <span>角色</span>
                  <select
                    value={form.role}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        role: event.target.value as WorkspaceUser["role"],
                      }))
                    }
                  >
                    {ROLE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                {editing && (
                  <label className="team-field">
                    <span>状态</span>
                    <select
                      value={form.status}
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          status: event.target.value as WorkspaceUser["status"],
                        }))
                      }
                    >
                      <option value="active">活跃</option>
                      <option value="disabled">已禁用</option>
                    </select>
                  </label>
                )}
              </div>
              <footer className="team-modal__footer">
                <button type="button" className="btn-secondary" onClick={closeModal}>
                  取消
                </button>
                <button type="submit" className="btn-primary" disabled={saving || !formReady}>
                  {saving ? "保存中…" : "保存"}
                </button>
              </footer>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
