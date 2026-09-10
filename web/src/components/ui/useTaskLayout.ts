"use client";

import { useCallback, useLayoutEffect, useRef } from "react";
import { motion, reducedMotion } from "./motion";

export function useTaskLayout(view: string, resultKey: string) {
  const ref = useRef<HTMLDivElement>(null);
  const animations = useRef<Animation[]>([]);
  const pending = useRef<{ id: string; offset: number; positions: Map<string, DOMRect> } | null>(null);
  const stop = useCallback(() => { animations.current.forEach(item => item.cancel()); animations.current = []; }, []);
  const capture = () => {
    stop();
    const root = ref.current;
    if (!root) return;
    const top = root.getBoundingClientRect().top;
    const cards = Array.from(root.querySelectorAll<HTMLElement>("[data-task-id]"));
    const anchor = cards.find(card => card.getBoundingClientRect().bottom > top);
    if (!anchor) return;
    pending.current = { id: anchor.dataset.taskId!, offset: anchor.getBoundingClientRect().top - top, positions: new Map(cards.filter(card => { const rect = card.getBoundingClientRect(); return rect.bottom > top && rect.top < top + root.clientHeight; }).map(card => [card.dataset.taskId!, card.querySelector(".task-card__identity")!.getBoundingClientRect()])) };
  };
  useLayoutEffect(() => {
    stop();
    const root = ref.current, snapshot = pending.current;
    pending.current = null;
    if (!root || !snapshot) return;
    const anchor = Array.from(root.querySelectorAll<HTMLElement>("[data-task-id]")).find(card => card.dataset.taskId === snapshot.id);
    if (anchor) {
      const offset = Math.max(snapshot.offset, 1 - anchor.getBoundingClientRect().height);
      root.scrollTop += anchor.getBoundingClientRect().top - root.getBoundingClientRect().top - offset;
    }
    const settledScroll = root.scrollTop;
    if (!reducedMotion()) {
      const bounds = root.getBoundingClientRect();
      const targets = Array.from(root.querySelectorAll<HTMLElement>("[data-task-id]")).map(card => {
        const old = snapshot.positions.get(card.dataset.taskId!);
        const identity = card.querySelector<HTMLElement>(".task-card__identity")!;
        const next = identity.getBoundingClientRect();
        return { old, identity, next };
      });
      // Finish every geometry read before starting animation writes.
      targets.forEach(({ old, identity, next }) => {
        if (!old || next.bottom <= bounds.top || next.top >= bounds.bottom) return;
        animations.current.push(identity.animate([{ transform: `translate(${old.left - next.left}px, ${old.top - next.top}px)`, opacity: .65 }, { transform: "translate(0,0)", opacity: 1 }], { duration: motion.layout, easing: motion.ease }));
      });
    }
    const scroll = () => { if (root.scrollTop !== settledScroll) stop(); };
    root.addEventListener("scroll", scroll, { passive: true });
    root.addEventListener("wheel", stop, { passive: true });
    root.addEventListener("touchmove", stop, { passive: true });
    window.addEventListener("resize", stop);
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    preference.addEventListener("change", stop);
    return () => { stop(); root.removeEventListener("scroll", scroll); root.removeEventListener("wheel", stop); root.removeEventListener("touchmove", stop); window.removeEventListener("resize", stop); preference.removeEventListener("change", stop); };
  }, [view, resultKey, stop]);
  return { ref, capture, stop };
}
