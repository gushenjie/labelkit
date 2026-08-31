"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { api, type Project } from "@/lib/api";

type GlobalLink = {
  href: string;
  label: string;
  icon: IconName;
};

const GLOBAL_LINKS: GlobalLink[] = [
  { href: "/", label: "项目管理", icon: "folder" },
  { href: "/tasks", label: "任务中心", icon: "archive" },
  { href: "/models", label: "模型中心", icon: "package" },
  { href: "/settings", label: "全局设置", icon: "settings" },
];

const PROJECT_ROUTE_LABELS: Record<string, string> = {
  materials: "素材管理",
  label: "自动标注",
  review: "人工复查",
  train: "训练导出",
  settings: "项目设置",
  tasks: "项目任务",
};

function isGlobalLinkActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/" || pathname.startsWith("/projects/");
  return pathname === href || pathname.startsWith(`${href}/`);
}

function currentGlobalLabel(pathname: string) {
  if (pathname.startsWith("/tasks")) return "任务中心";
  if (pathname.startsWith("/models")) return "模型中心";
  if (pathname.startsWith("/settings")) return "全局设置";
  return "项目管理";
}

export function Nav() {
  const pathname = usePathname();
  const projectMatch = pathname.match(/^\/projects\/([^/]+)/);
  const projectId = projectMatch?.[1] ?? "";
  const projectRoute = projectId ? pathname.split("/")[3] ?? "" : "";
  const [project, setProject] = useState<Project | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

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
  const isProjectManagement = pathname === "/";
  const pageDescription = isProjectManagement
    ? "管理视频素材、智能标注、人工复查与模型训练的完整生产流程"
    : pathname.startsWith("/tasks")
      ? "查看所有项目的后台任务进度与历史"
      : pathname.startsWith("/models")
        ? "查看项目模型版本，并在线试用检测效果"
        : pathname.startsWith("/settings")
          ? "配置标注服务访问凭证、模型参数与执行策略"
      : "";

  return (
    <>
      <aside className={`app-sidebar ${drawerOpen ? "app-sidebar--open" : ""}`}>
        <div className="app-sidebar__brand-row">
          <Link href="/" className="brand-lockup" aria-label="LabelKit 首页">
            <span className="brand-mark" aria-hidden="true">
              <svg viewBox="0 0 32 32">
                <path d="M16 5.2 24.5 10v12L16 26.8 7.5 22V10z" fill="currentColor" />
              </svg>
            </span>
            <span className="brand-lockup__name">LabelKit</span>
          </Link>
          <span className="app-sidebar__edition">VISION OPS</span>
          <button
            type="button"
            className="app-sidebar__close"
            aria-label="收起导航菜单"
            onClick={() => setDrawerOpen(false)}
          >
            <Icon name="x" size={18} />
          </button>
        </div>

        <div className="app-sidebar__scroll">
          <span className="app-sidebar__section-label">工作空间</span>
          <nav className="app-sidebar__nav" aria-label="全局导航">
            {GLOBAL_LINKS.map((link) => {
              const active = isGlobalLinkActive(pathname, link.href);
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

        </div>

        <div className="app-sidebar__footer">
          <span className="app-sidebar__status-dot" aria-hidden="true" />
          <span>
            <strong>本地工作区</strong>
            <small>LabelKit v0.2</small>
          </span>
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
          <Link href="/" className="app-commandbar__mobile-brand" aria-label="LabelKit 首页">
            <span className="brand-mark" aria-hidden="true">
              <svg viewBox="0 0 32 32">
                <path d="M16 5.2 24.5 10v12L16 26.8 7.5 22V10z" fill="currentColor" />
              </svg>
            </span>
            <strong>LabelKit</strong>
          </Link>
          <nav className="app-breadcrumbs" aria-label="当前位置">
            <div className="app-breadcrumbs__trail">
              {projectId ? (
                <>
                <Link href="/">项目管理</Link>
                <Icon name="chevron-right" size={13} />
                <Link href={`/projects/${projectId}`} title={project?.name}>
                  {project?.name || "项目"}
                </Link>
                <Icon name="chevron-right" size={13} />
                <strong>{breadcrumbLabel}</strong>
                </>
              ) : (
                <strong>{breadcrumbLabel}</strong>
              )}
            </div>
            {pageDescription && <p>{pageDescription}</p>}
          </nav>
        </div>
        <div className="app-commandbar__actions">
          {isProjectManagement && (
            <button
              type="button"
              className="btn-primary app-commandbar__create"
              onClick={() => window.dispatchEvent(new Event("open-create-project"))}
            >
              <Icon name="plus" size={16} />
              新建项目
            </button>
          )}
        </div>
      </header>

    </>
  );
}
