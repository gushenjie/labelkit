"use client";

import Link from "next/link";
import { useParams, usePathname, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import { api } from "@/lib/api";
import {
  matchesProjectLiveEvent,
  PROJECT_MODELS_REFRESH_EVENT,
  PROJECT_STATS_REFRESH_EVENT,
} from "@/lib/project-live";
import { computeCurrentWorkflowStep, computeStepBadges, isWorkflowStepUnlocked, WORKFLOW_STEPS } from "@/lib/workflow";

type ProjectContextBarProps = {
  compact?: boolean;
};

/** 步骤角标：统计慢轮询；模型数量按需刷新 */
const STATS_POLL_MS = 12000;

export function ProjectContextBar({ compact = false }: ProjectContextBarProps) {
  const { id } = useParams<{ id: string }>();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [stats, setStats] = useState<Record<string, number>>({});
  const [modelCount, setModelCount] = useState(0);

  useEffect(() => {
    if (!id) return;

    let active = true;
    const loadStats = () => {
      api.frameStats(id)
        .then((nextStats) => {
          if (!active) return;
          setStats(nextStats);
        })
        .catch(() => {
          if (!active) return;
          setStats({});
        });
    };

    loadStats();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      loadStats();
    }, STATS_POLL_MS);

    const onRefresh = (event: Event) => {
      if (!matchesProjectLiveEvent(event, id)) return;
      loadStats();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") loadStats();
    };

    window.addEventListener(PROJECT_STATS_REFRESH_EVENT, onRefresh);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener(PROJECT_STATS_REFRESH_EVENT, onRefresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [id]);

  useEffect(() => {
    if (!id) return;

    let active = true;
    const loadModels = () => {
      api.listModels(id)
        .then((models) => {
          if (!active) return;
          setModelCount(models.length);
        })
        .catch(() => {
          if (!active) return;
          setModelCount(0);
        });
    };

    loadModels();
    const onRefresh = (event: Event) => {
      if (!matchesProjectLiveEvent(event, id)) return;
      loadModels();
    };
    window.addEventListener(PROJECT_MODELS_REFRESH_EVENT, onRefresh);
    return () => {
      active = false;
      window.removeEventListener(PROJECT_MODELS_REFRESH_EVENT, onRefresh);
    };
  }, [id]);

  // 进入训练相关路由时补一次模型数（可能刚训练完）
  useEffect(() => {
    if (!id) return;
    if (!pathname.includes("/train") && !pathname.includes("/models")) return;
    api.listModels(id)
      .then((models) => setModelCount(models.length))
      .catch(() => undefined);
  }, [id, pathname]);

  const stepBadges = useMemo(() => computeStepBadges(stats, modelCount), [stats, modelCount]);
  const recommendedStepSlug = computeCurrentWorkflowStep(stats, modelCount);
  const viewingStepSlug = useMemo(() => {
    if (!id) return null;
    if (pathname.startsWith(`/projects/${id}/review`) && searchParams.get("filter") === "manual") {
      return "label";
    }
    return WORKFLOW_STEPS.find((step) => {
      const prefix = `/projects/${id}/${step.slug}`;
      return pathname === prefix || pathname.startsWith(`${prefix}/`);
    })?.slug ?? null;
  }, [id, pathname, searchParams]);
  const displayStepSlug = viewingStepSlug ?? recommendedStepSlug;
  const displayStepIndex = WORKFLOW_STEPS.findIndex((step) => step.slug === displayStepSlug);
  const displayStep = WORKFLOW_STEPS[displayStepIndex] ?? WORKFLOW_STEPS[0];

  if (compact) {
    return (
      <section className="project-context-bar flex items-center gap-3 bg-white border border-[var(--lk-border)] shadow-[var(--lk-shadow-panel)] rounded-[var(--lk-radius-lg)] px-4 py-2" aria-label="当前项目生产阶段">
        <div className="w-10 h-10 rounded-[var(--lk-radius-md)] bg-[var(--lk-brand-600)] text-white flex items-center justify-center font-bold font-mono text-compact-title">
          {String(displayStepIndex + 1)}
        </div>
        <div className="flex flex-col">
          <small className="text-micro font-bold text-[#10A88F] uppercase tracking-wider mb-0.5">当前阶段</small>
          <strong className="text-body-sm font-bold text-[var(--lk-ink)] leading-none">{displayStep.label}</strong>
        </div>
      </section>
    );
  }

  return (
    <section className="project-context-bar flex items-stretch bg-white border border-[var(--lk-border)] shadow-[var(--lk-shadow-panel)] rounded-[var(--lk-radius-lg)] h-[68px] overflow-hidden" aria-label="项目生产流程">
      <nav className="flex flex-1" aria-label="项目生产流程">
        {WORKFLOW_STEPS.map((step, index) => {
          const href = `/projects/${id}/${step.slug}`;
          const viewing = step.slug === viewingStepSlug;
          const current = step.slug === displayStepSlug;
          const backlog = step.slug === recommendedStepSlug && recommendedStepSlug !== displayStepSlug;
          const badge = stepBadges.find((item) => item.slug === step.slug);
          // 当前正在查看的步骤始终视为可选中，避免「已进入页面但步骤条仍灰显」
          const unlocked = isWorkflowStepUnlocked(step.slug, stepBadges, stats) || viewing;
          const previousLabel = index > 0 ? WORKFLOW_STEPS[index - 1].label : "";
          let stateClass = "text-[#17343A]/50 hover:bg-gray-50/50";
          let numClass = "bg-gray-100 text-[#17343A]/40";
          if (!unlocked) {
            stateClass = "text-[#17343A]/35 cursor-not-allowed";
            numClass = "bg-gray-100 text-[#17343A]/28";
          } else if (current || viewing) {
            stateClass = "text-[var(--lk-ink)] bg-[var(--lk-brand-50)]";
            numClass = "bg-[var(--lk-brand-600)] text-white";
          } else if (badge?.done) {
            stateClass = "text-[#17343A]/70";
            numClass = "bg-[#F4FAF8] text-[#10A88F] border border-[#CFF4EC]/50";
          }
          if (viewing && unlocked) {
            stateClass += " relative after:absolute after:bottom-0 after:inset-x-0 after:h-0.5 after:bg-[var(--lk-brand-500)]";
          }

          const title = !unlocked
            ? `请先完成「${previousLabel}」后再进入此步骤`
            : viewing && !current
              ? `正在查看「${step.label}」；当前主阶段为「${displayStep.label}」`
              : backlog
                ? `主阶段已进入「${displayStep.label}」，此步仍有 ${badge?.count ?? 0} 项待处理`
                : step.description;

          const content = (
            <>
              {index > 0 && <div className="absolute left-0 top-1/2 -translate-y-1/2 w-px h-6 bg-[var(--lk-border)]" />}
              <span className={`w-8 h-8 rounded-full flex items-center justify-center text-body-sm font-bold transition-all ${numClass}`}>
                {badge?.done && !current ? <Icon name="check" size={14} /> : index + 1}
              </span>
              <span className="flex flex-col min-w-0 pr-2">
                <small className="text-micro font-bold uppercase tracking-widest opacity-60 mb-0.5 leading-none">STEP {String(index + 1).padStart(2, "0")}</small>
                <strong className={`text-body-sm font-bold truncate leading-none transition-colors ${unlocked ? "group-hover:text-[#10A88F]" : ""}`}>{step.label}</strong>
              </span>
              {unlocked && badge?.count ? <em className="absolute top-2 right-2 bg-red-500 text-white text-micro font-bold px-1.5 py-0.5 rounded-md leading-none shadow-sm shadow-red-500/20">{badge.count}</em> : null}
            </>
          );

          if (!unlocked) {
            return (
              <span
                key={step.slug}
                aria-disabled="true"
                title={title}
                className={`flex-1 flex items-center justify-center gap-2 relative ${stateClass}`}
              >
                {content}
              </span>
            );
          }

          return (
            <Link
              key={step.slug}
              href={href}
              aria-current={viewing ? "page" : undefined}
              title={title}
              className={`flex-1 flex items-center justify-center gap-2 relative transition-colors group ${stateClass}`}
            >
              {content}
            </Link>
          );
        })}
      </nav>

      <div className="flex flex-col items-center justify-center px-5 border-l border-[var(--lk-border)] bg-[var(--lk-surface-soft)] min-w-[112px]">
        <span className="text-micro font-bold text-[#10A88F] uppercase tracking-wider mb-1">当前阶段</span>
        <strong className="text-metric font-bold text-[var(--lk-ink)] leading-none font-mono tracking-tighter">
          {String(displayStepIndex + 1).padStart(2, "0")} <span className="text-body text-[#17343A]/30 font-normal">/ 04</span>
        </strong>
      </div>
    </section>
  );
}
