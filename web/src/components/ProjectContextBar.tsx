"use client";

import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { api } from "@/lib/api";
import { computeStepBadges, type WorkflowStep } from "@/lib/workflow";

const PROJECT_STEPS: { slug: WorkflowStep; label: string }[] = [
  { slug: "materials", label: "素材管理" },
  { slug: "label", label: "自动标注" },
  { slug: "review", label: "人工复查" },
  { slug: "train", label: "训练导出" },
];

export function ProjectContextBar() {
  const { id } = useParams<{ id: string }>();
  const pathname = usePathname();
  const [stats, setStats] = useState<Record<string, number>>({});
  const [modelCount, setModelCount] = useState(0);

  useEffect(() => {
    if (!id) return;

    let active = true;
    const load = () => {
      Promise.all([api.frameStats(id), api.listModels(id)])
        .then(([nextStats, models]) => {
          if (!active) return;
          setStats(nextStats);
          setModelCount(models.length);
        })
        .catch(() => {
          if (!active) return;
          setStats({});
          setModelCount(0);
        });
    };

    load();
    const timer = window.setInterval(load, 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [id]);

  const stepBadges = useMemo(() => computeStepBadges(stats, modelCount), [stats, modelCount]);
  const activeStepIndex = PROJECT_STEPS.findIndex((step) =>
    pathname.startsWith(`/projects/${id}/${step.slug}`),
  );

  return (
    <section className="project-context-bar" aria-label="项目生产流程">
      <nav className="project-context-bar__workflow" aria-label="项目生产流程">
        {PROJECT_STEPS.map((step, index) => {
          const href = `/projects/${id}/${step.slug}`;
          const active = pathname.startsWith(href);
          const badge = stepBadges.find((item) => item.slug === step.slug);
          return (
            <Link
              key={step.slug}
              href={href}
              aria-current={active ? "page" : undefined}
              className={[
                "project-context-step",
                active ? "project-context-step--active" : "",
                badge?.done ? "project-context-step--done" : "",
              ].filter(Boolean).join(" ")}
            >
              <span>{badge?.done && !active ? <Icon name="check" size={12} /> : index + 1}</span>
              <span className="project-context-step__copy">
                <small>STEP {String(index + 1).padStart(2, "0")}</small>
                <strong>{step.label}</strong>
              </span>
              {badge?.count ? <em>{badge.count}</em> : null}
            </Link>
          );
        })}
      </nav>

      <div className="project-context-bar__stage">
        <span>{activeStepIndex >= 0 ? "当前阶段" : "生产流程"}</span>
        <strong>
          {activeStepIndex >= 0
            ? `${String(activeStepIndex + 1).padStart(2, "0")} / 04`
            : "4 个阶段"}
        </strong>
      </div>
    </section>
  );
}
