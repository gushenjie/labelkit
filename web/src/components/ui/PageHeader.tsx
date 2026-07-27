import type { ReactNode } from "react";

export type PageHeaderProps = {
  title: string;
  description?: string;
  action?: ReactNode;
  meta?: ReactNode;
  eyebrow?: string;
};

export function PageHeader({ title, description, action, meta, eyebrow }: PageHeaderProps) {
  return (
    <header className="page-header">
      <div className="page-header__copy">
        {eyebrow && <span className="page-header__eyebrow">{eyebrow}</span>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
        {meta}
      </div>
      {action && <div className="page-header__action">{action}</div>}
    </header>
  );
}
