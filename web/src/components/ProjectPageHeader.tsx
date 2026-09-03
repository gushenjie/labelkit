import { ReactNode } from "react";
import { ProjectContextBar } from "@/components/ProjectContextBar";

export type ProjectPageHeaderProps = {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  meta?: ReactNode;
  eyebrow?: string;
  showContext?: boolean;
  /** 图像工作区紧凑顶栏：缩小标题、隐藏描述，便于一屏展示 */
  compact?: boolean;
};

export function ProjectPageHeader({
  title,
  description,
  action,
  meta,
  eyebrow,
  showContext = true,
  compact = false,
}: ProjectPageHeaderProps) {
  return (
    <div
      className={`project-page-heading flex justify-between items-start gap-6 shrink-0 w-full relative z-10 ${compact ? "mb-2" : "mb-6"}`}
    >
      <div className="flex min-w-0 flex-1 flex-col pr-2">
        {eyebrow && <span className="text-[10px] font-bold tracking-wider text-[var(--lk-brand-700)] uppercase mb-1 block">{eyebrow}</span>}
        <h1 className={`font-bold text-[var(--lk-ink)] ${compact ? "text-lg leading-tight" : "text-2xl"}`}>{title}</h1>
        {description && !compact && (
          <div className="page-header__copy text-sm text-[var(--lk-muted)] mt-1 max-w-2xl">{description}</div>
        )}
        {meta && <div className="mt-3">{meta}</div>}
      </div>
      {(showContext || action) && (
        <div className="flex w-[min(800px,42vw)] shrink-0 flex-col items-end gap-3">
          {action && <div className="shrink-0">{action}</div>}
          {showContext && (
            <div className="w-full [&_.project-context-bar]:mb-0">
              <ProjectContextBar />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
