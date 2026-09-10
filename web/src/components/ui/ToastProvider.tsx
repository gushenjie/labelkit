"use client";

import Link from "next/link";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Presence } from "./motion";
import { useExitItems } from "./useExitItems";

export type ToastAction = {
  label: string;
  href?: string;
  onClick?: () => void;
};

export type ToastItem = {
  id: string;
  type: "success" | "error" | "info";
  message: string;
  action?: ToastAction;
  duration?: number;
};

type ToastContextValue = {
  toasts: ToastItem[];
  toast: (item: Omit<ToastItem, "id">) => string;
  dismiss: (id: string) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

let toastSeq = 0;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const displayed = useExitItems(toasts);
  const active = useRef(new Set<string>());
  const timers = useRef(new Map<string, number>());
  useEffect(() => () => { timers.current.forEach(timer => window.clearTimeout(timer)); }, []);

  const dismiss = useCallback((id: string) => {
    if (!active.current.delete(id)) return;
    window.clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (item: Omit<ToastItem, "id">) => {
      const id = `toast-${++toastSeq}`;
      const duration = item.duration ?? (item.type === "error" ? 6000 : 4500);
      active.current.add(id);
      setToasts((prev) => [...prev.slice(-4), { ...item, id }]);
      if (duration > 0) {
        timers.current.set(id, window.setTimeout(() => dismiss(id), duration));
      }
      return id;
    },
    [dismiss],
  );

  const value = useMemo(() => ({ toasts, toast, dismiss }), [toasts, toast, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-stack" aria-live="polite" aria-relevant="additions">
        {displayed.map(({ item: t, exiting }) => (
          <Presence open={!exiting} key={t.id} className={`toast toast--${t.type}`} role="status">
            <p className="toast__message">{t.message}</p>
            <div className="toast__actions">
              {t.action && (
                t.action.href ? (
                  <Link href={t.action.href} className="toast__action" onClick={() => dismiss(t.id)}>
                    {t.action.label}
                  </Link>
                ) : (
                  <button
                    type="button"
                    className="toast__action"
                    onClick={() => {
                      if (!active.current.has(t.id)) return;
                      dismiss(t.id);
                      t.action?.onClick?.();
                    }}
                  >
                    {t.action.label}
                  </button>
                )
              )}
              <button type="button" className="toast__dismiss" onClick={() => dismiss(t.id)} aria-label="关闭">
                ×
              </button>
            </div>
          </Presence>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}
