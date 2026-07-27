"use client";

import Link from "next/link";
import { createContext, useCallback, useContext, useMemo, useState } from "react";

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

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (item: Omit<ToastItem, "id">) => {
      const id = `toast-${++toastSeq}`;
      const duration = item.duration ?? (item.type === "error" ? 6000 : 4500);
      setToasts((prev) => [...prev.slice(-4), { ...item, id }]);
      if (duration > 0) {
        window.setTimeout(() => dismiss(id), duration);
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
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast--${t.type}`} role="status">
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
                      t.action?.onClick?.();
                      dismiss(t.id);
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
          </div>
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
