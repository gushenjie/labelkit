import type { ReactNode } from "react";

export function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`panel ${className}`.trim()}>{children}</section>;
}

export function PanelSection({
  title,
  children,
  action,
  id,
}: {
  title?: string;
  children: ReactNode;
  action?: ReactNode;
  id?: string;
}) {
  return (
    <div className="panel-section" id={id}>
      {(title || action) && (
        <div className="panel-section__head">
          {title && <h2>{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </div>
  );
}
