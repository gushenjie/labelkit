"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { BrandMarkIcon } from "@/components/BrandMark";
import { api, type Project } from "@/lib/api";
import { BRAND, brandHomeLabel, brandVersionLabel } from "@/lib/app-config";
import { getAuthProfile, logout } from "@/lib/auth";

type GlobalLink = {
  href: string;
  label: string;
  icon: IconName;
  disabled?: boolean;
};

const WORKSPACE_LINKS: GlobalLink[] = [
  { href: "/", label: "项目管理", icon: "folder" },
  { href: "/datasets", label: "数据管理", icon: "database" },
  { href: "/tasks", label: "任务中心", icon: "archive" },
  { href: "/models", label: "模型中心", icon: "package" },
];

const ADMIN_LINKS: GlobalLink[] = [
  { href: "/team", label: "团队成员", icon: "users" },
  { href: "/audit", label: "审计日志", icon: "audit" },
  { href: "/settings", label: "全局设置", icon: "settings" },
];

const ROLE_LABELS: Record<string, string> = {
  admin: "管理员",
  annotator: "标注员",
  reviewer: "审核员",
  viewer: "只读",
};

const PROJECT_ROUTE_LABELS: Record<string, string> = {
  materials: "素材准备",
  label: "AI 预标注",
  review: "标注复核",
  train: "训练或导出",
  settings: "项目设置",
  tasks: "项目任务",
};

function isGlobalLinkActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/" || pathname.startsWith("/projects/");
  return pathname === href || pathname.startsWith(`${href}/`);
}

function currentGlobalLabel(pathname: string) {
  if (pathname.startsWith("/datasets")) return "数据管理";
  if (pathname.startsWith("/tasks")) return "任务中心";
  if (pathname.startsWith("/models")) return "模型中心";
  if (pathname.startsWith("/settings")) return "全局设置";
  if (pathname.startsWith("/team")) return "团队成员";
  if (pathname.startsWith("/audit")) return "审计日志";
  return "项目管理";
}

export function Nav() {
  const pathname = usePathname();
  const projectMatch = pathname.match(/^\/projects\/([^/]+)/);
  const projectId = projectMatch?.[1] ?? "";
  const projectRoute = projectId ? pathname.split("/")[3] ?? "" : "";
  const [project, setProject] = useState<Project | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState("");

  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!drawerOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [drawerOpen]);

  useEffect(() => {
    let active = true;
    api.getAuthSession()
      .then((session) => {
        if (!active) return;
        setUsername(session.username);
        setDisplayName(session.display_name || session.username);
        setRole(session.role || "");
      })
      .catch(() => {
        if (!active) return;
        const profile = getAuthProfile();
        setUsername(profile?.username ?? "");
        setDisplayName(profile?.display_name ?? "");
        setRole(profile?.role ?? "");
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!projectId) {
      setProject(null);
      return;
    }

    let active = true;
    const load = () => {
      api.getProject(projectId)
        .then((nextProject) => {
          if (!active) return;
          setProject(nextProject);
        })
        .catch(() => {
          if (!active) return;
          setProject(null);
        });
    };

    load();
    const timer = window.setInterval(load, 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [projectId]);

  const breadcrumbLabel = projectId
    ? PROJECT_ROUTE_LABELS[projectRoute] ?? "项目概览"
    : currentGlobalLabel(pathname);
  const isProjectSubRoute = Boolean(projectId && projectRoute);
  const projectBackHref = isProjectSubRoute ? `/projects/${projectId}` : projectId ? "/" : "";
  const projectBackLabel = isProjectSubRoute ? "返回项目概览" : "返回项目列表";
  const isProjectManagement = pathname === "/";
  const isDatasetCenter = pathname === "/datasets";
  const isTaskCenter = pathname === "/tasks";
  const isModelCenter = pathname === "/models";
  const isAuditCenter = pathname === "/audit";
  const pageDescription = isProjectManagement
    ? "管理素材准备、AI 预标注、标注复核与模型产出的完整生产流程"
    : pathname.startsWith("/datasets")
      ? "管理您的数据集版本，训练与评估模型"
    : pathname.startsWith("/tasks")
      ? "查看所有项目的后台任务进度与历史"
      : pathname.startsWith("/models")
        ? "统一管理、评估和部署工作区中的 AI 模型"
        : pathname.startsWith("/settings")
          ? "配置标注服务访问凭证、模型参数与执行策略"
          : pathname.startsWith("/team")
            ? "管理工作区成员账号、角色与登录状态"
          : pathname.startsWith("/audit")
            ? "查看工作区内的操作记录与关键变更留痕"
      : "";

  return (
    <>
      <aside className={`app-sidebar app-sidebar--workspace ${drawerOpen ? "app-sidebar--open" : ""}`}>
        <div className="app-sidebar__brand-row">
          <Link href="/" className="brand-lockup" aria-label={brandHomeLabel}>
            <span className="brand-mark" aria-hidden="true">
              <BrandMarkIcon />
            </span>
            <span className="brand-lockup__copy">
              <span className="brand-lockup__name">{BRAND.fullName}</span>
              <span className="app-sidebar__edition">{BRAND.edition}</span>
            </span>
          </Link>
          <button
            type="button"
            className="app-sidebar__close"
            aria-label="收起导航菜单"
            onClick={() => setDrawerOpen(false)}
          >
            <Icon name="x" size={18} />
          </button>
        </div>

        <div className="app-sidebar__scroll lk-scrollbar">
          <span className="app-sidebar__section-label">工作空间</span>
          <nav className="app-sidebar__nav" aria-label="工作空间导航">
            {WORKSPACE_LINKS.map((link) => {
              const active = isGlobalLinkActive(pathname, link.href);
              if (link.disabled) {
                return (
                  <span key={link.href} className="app-sidebar__nav-link app-sidebar__nav-link--disabled" aria-disabled="true">
                    <span className="app-sidebar__nav-icon"><Icon name={link.icon} size={18} /></span>
                    <span className="app-sidebar__nav-label">{link.label}</span>
                  </span>
                );
              }
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  title={link.label}
                  aria-current={active ? "page" : undefined}
                  className={active ? "app-sidebar__nav-link app-sidebar__nav-link--active" : "app-sidebar__nav-link"}
                >
                  <span className="app-sidebar__nav-icon">
                    <Icon name={link.icon} size={18} />
                  </span>
                  <span className="app-sidebar__nav-label">{link.label}</span>
                </Link>
              );
            })}
          </nav>

          <span className="app-sidebar__section-label app-sidebar__section-label--admin">管理</span>
          <nav className="app-sidebar__nav" aria-label="管理导航">
            {ADMIN_LINKS.map((link) => {
              const active = isGlobalLinkActive(pathname, link.href);
              if (link.disabled) {
                return (
                  <span key={link.href} className="app-sidebar__nav-link app-sidebar__nav-link--disabled" aria-disabled="true">
                    <span className="app-sidebar__nav-icon"><Icon name={link.icon} size={18} /></span>
                    <span className="app-sidebar__nav-label">{link.label}</span>
                  </span>
                );
              }
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  title={link.label}
                  aria-current={active ? "page" : undefined}
                  className={active ? "app-sidebar__nav-link app-sidebar__nav-link--active" : "app-sidebar__nav-link"}
                >
                  <span className="app-sidebar__nav-icon"><Icon name={link.icon} size={18} /></span>
                  <span className="app-sidebar__nav-label">{link.label}</span>
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="app-sidebar__footer">
          <span className="app-sidebar__status-dot" aria-hidden="true">
            {(displayName || username || "本").slice(0, 1).toUpperCase()}
          </span>
          <span className="app-sidebar__footer-meta">
            <strong>{displayName || username || (projectId ? "快捷入口" : "本地工作区")}</strong>
            <small>{role ? ROLE_LABELS[role] ?? role : projectId ? "SDK 文档 · v2.0" : brandVersionLabel}</small>
          </span>
          <button
            type="button"
            className="app-sidebar__logout"
            aria-label="退出登录"
            title="退出登录"
            onClick={logout}
          >
            <Icon name="log-out" size={16} />
          </button>
        </div>
      </aside>

      {drawerOpen && (
        <button
          type="button"
          className="app-sidebar__backdrop"
          aria-label="关闭导航菜单"
          onClick={() => setDrawerOpen(false)}
        />
      )}

      <header className="app-commandbar">
        <div className="app-commandbar__left">
          <button
            type="button"
            className="app-commandbar__menu"
            aria-label="打开导航菜单"
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen((value) => !value)}
          >
            <Icon name="menu" size={20} />
          </button>
          <Link href="/" className="app-commandbar__mobile-brand" aria-label={brandHomeLabel}>
            <span className="brand-mark" aria-hidden="true">
              <BrandMarkIcon />
            </span>
            <strong>{BRAND.fullName}</strong>
          </Link>
          {projectId && projectBackHref ? (
            <Link
              href={projectBackHref}
              className="app-commandbar__back"
              aria-label={projectBackLabel}
              title={projectBackLabel}
            >
              <Icon name="chevron-left" size={18} />
            </Link>
          ) : null}
          <nav className="app-breadcrumbs" aria-label="当前位置">
            <div className="app-breadcrumbs__trail">
              {isDatasetCenter ? (
                <h1>数据管理</h1>
              ) : isTaskCenter ? (
                <h1>任务中心</h1>
              ) : isModelCenter ? (
                <strong>模型中心</strong>
              ) : isAuditCenter ? (
                <h1>审计日志</h1>
              ) : projectId ? (
                <>
                <Link href="/">项目管理</Link>
                {isProjectSubRoute ? (
                  <>
                    <Icon name="chevron-right" size={13} />
                    <Link href={`/projects/${projectId}`} title={project?.name}>
                      {project?.name || "项目概览"}
                    </Link>
                    <Icon name="chevron-right" size={13} />
                    <strong>{breadcrumbLabel}</strong>
                  </>
                ) : (
                  <>
                    <Icon name="chevron-right" size={13} />
                    <strong title={project?.name}>{project?.name || "项目概览"}</strong>
                  </>
                )}
                </>
              ) : (
                <strong>{breadcrumbLabel}</strong>
              )}
            </div>
            {pageDescription && <p>{pageDescription}</p>}
          </nav>
        </div>
        <div className="app-commandbar__actions">
          {projectId && (
            <>
              <button type="button" className="icon-button icon-button--ghost" aria-label="通知">
                <Icon name="bell" size={21} />
              </button>
              <button type="button" className="project-account" aria-label="当前用户：刘智">
                <span>刘</span>
                <Icon name="chevron-down" size={16} />
              </button>
            </>
          )}
          {(isProjectManagement || isDatasetCenter || isTaskCenter || isModelCenter) && (
            isDatasetCenter ? (
              <button
                type="button"
                className="btn-primary app-commandbar__create"
                onClick={() => window.dispatchEvent(new Event("open-create-dataset-version"))}
              >
                <Icon name="plus" size={16} />
                创建数据集
              </button>
            ) : isTaskCenter ? (
              <Link href="/?create=1" className="btn-primary app-commandbar__create">
                <Icon name="plus" size={16} />
                新建项目
              </Link>
            ) : isModelCenter ? (
              <>
                <button type="button" className="icon-button icon-button--ghost" aria-label="通知">
                  <Icon name="bell" size={22} />
                  <span className="notification-dot" />
                </button>
                <Link href="/?create=1" className="btn-primary app-commandbar__create">
                  <Icon name="plus" size={16} />
                  新建项目
                </Link>
              </>
            ) : (
            <button
              type="button"
              className="btn-primary app-commandbar__create"
              onClick={() => window.dispatchEvent(new Event("open-create-project"))}
            >
              <Icon name="plus" size={16} />
              新建项目
            </button>
            )
          )}
        </div>
      </header>

    </>
  );
}
