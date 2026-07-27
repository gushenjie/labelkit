"use client";

import Link from "next/link";
import type { ContinueAction } from "@/lib/workflow";

export function ContinueBar({ action }: { action: ContinueAction }) {
  return (
    <div className="continue-bar">
      <div className="continue-bar__copy">
        <p className="continue-bar__label">继续工作</p>
        <p className="continue-bar__desc">{action.description}</p>
      </div>
      <Link href={action.href} className="btn-primary continue-bar__cta">
        {action.label}
        {action.count != null && action.count > 0 ? ` (${action.count})` : ""}
      </Link>
    </div>
  );
}
