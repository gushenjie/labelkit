"use client";

import { useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode } from "react";

export const motion = { feedback: 120, enter: 180, exit: 160, layout: 280, data: 320, ease: "cubic-bezier(.22,1,.36,1)" };
export const reducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Keep the outgoing content alive without keeping its actions alive. */
export function Presence({ open, children, fadeOnly = false, ...props }: HTMLAttributes<HTMLDivElement> & { open: boolean; children: ReactNode; fadeOnly?: boolean }) {
  const [present, setPresent] = useState(open);
  const element = useRef<HTMLDivElement>(null);
  const snapshot = useRef(children);
  useLayoutEffect(() => { if (open) snapshot.current = children; }, [open, children]);
  useLayoutEffect(() => {
    const node = element.current;
    if (!node) return;
    if (open) setPresent(true);
    if (reducedMotion()) { setPresent(open); return; }
    const animation = node.animate(open ? [{ opacity: 0, transform: fadeOnly ? "none" : "translateY(4px)" }, { opacity: 1, transform: fadeOnly ? "none" : "translateY(0)" }] : [{ opacity: 1 }, { opacity: 0 }], { duration: open ? motion.enter : motion.exit, easing: motion.ease });
    animation.onfinish = () => { if (!open) setPresent(false); };
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const finish = () => { if (preference.matches) { animation.cancel(); setPresent(open); } };
    preference.addEventListener("change", finish);
    return () => { animation.cancel(); preference.removeEventListener("change", finish); };
  }, [open, fadeOnly]);
  return open || present ? <div {...props} ref={element} data-presence={open ? "open" : "closing"} inert={!open} aria-hidden={!open || undefined}>{open ? children : snapshot.current}</div> : null;
}

/** Values always stay truthful; only the replacement is animated. */
export function ChangedValue({ value, className = "" }: { value: string | number; className?: string }) {
  const element = useRef<HTMLSpanElement>(null);
  const previous = useRef(value);
  useLayoutEffect(() => {
    if (previous.current === value) return;
    previous.current = value;
    if (reducedMotion()) return;
    const animation = element.current?.animate([{ opacity: .45, transform: "translateY(2px)" }, { opacity: 1, transform: "translateY(0)" }], { duration: motion.data, easing: motion.ease });
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const stop = () => { if (preference.matches) animation?.cancel(); };
    preference.addEventListener("change", stop);
    return () => { animation?.cancel(); preference.removeEventListener("change", stop); };
  }, [value]);
  return <span ref={element} className={`lk-changed-value ${className}`}>{value}</span>;
}

const modalStack: HTMLElement[] = [];
let savedOverflow = "";
export function ModalSurface({ open, onClose, busy = false, children }: { open: boolean; onClose: () => void; busy?: boolean; children: ReactNode }) {
  const container = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  const blocked = useRef(busy);
  close.current = onClose;
  blocked.current = busy;
  useLayoutEffect(() => {
    if (!open || !container.current) return;
    const node = container.current;
    const origin = document.activeElement as HTMLElement | null;
    if (!modalStack.length) { savedOverflow = document.body.style.overflow; document.body.style.overflow = "hidden"; }
    modalStack.push(node);
    const entrance = reducedMotion() ? null : node.animate([{ transform: "translateY(8px)" }, { transform: "translateY(0)" }], { duration: 220, easing: motion.ease });
    const focusable = () => Array.from(node.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]')).filter(el => el.getClientRects().length && !el.closest("[inert]"));
    (focusable()[0] ?? node).focus();
    const keys = (event: KeyboardEvent) => {
      if (modalStack.at(-1) !== node) return;
      if (event.key === "Escape") { event.preventDefault(); if (!blocked.current) close.current(); }
      if (event.key === "Tab") {
        const targets = focusable();
        if (!targets.length) { event.preventDefault(); node.focus(); return; }
        const index = targets.indexOf(document.activeElement as HTMLElement);
        if (event.shiftKey && index <= 0) { event.preventDefault(); targets.at(-1)?.focus(); }
        else if (!event.shiftKey && (index === -1 || index === targets.length - 1)) { event.preventDefault(); targets[0].focus(); }
      }
    };
    const contain = (event: FocusEvent) => { if (modalStack.at(-1) === node && !node.contains(event.target as Node)) (focusable()[0] ?? node).focus(); };
    document.addEventListener("keydown", keys);
    document.addEventListener("focusin", contain);
    return () => {
      entrance?.cancel();
      document.removeEventListener("keydown", keys);
      document.removeEventListener("focusin", contain);
      modalStack.splice(modalStack.indexOf(node), 1);
      if (!modalStack.length) document.body.style.overflow = savedOverflow;
      if (origin?.isConnected && !origin.closest("[inert]")) origin.focus();
    };
  }, [open]);
  return <Presence open={open} fadeOnly className="modal-backdrop lk-modal-surface" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}><div ref={container} tabIndex={-1} className="lk-modal-content">{children}</div></Presence>;
}
