"use client";

import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { ModalSurface } from "./motion";

type ConfirmOptions = {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
};

type ConfirmContextValue = {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
};

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((v: boolean) => void) | null>(null);
  const titleId = useId();
  useEffect(() => () => { resolver.current?.(false); resolver.current = null; }, []);

  const confirm = useCallback((opts: ConfirmOptions) => {
    resolver.current?.(false);
    setOptions(opts);
    setOpen(true);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const close = useCallback(
    (result: boolean) => {
      const resolve = resolver.current;
      if (!resolve) return;
      resolver.current = null;
      setOpen(false);
      setOptions(null);
      resolve(result);
    },
    [],
  );

  const value = useMemo(() => ({ confirm }), [confirm]);

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      <ModalSurface open={open} onClose={() => close(false)}>
        {options && (
          <div
            className="confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={titleId}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id={titleId} className="confirm-dialog__title">
              {options.title}
            </h2>
            <p className="confirm-dialog__message">{options.message}</p>
            <div className="confirm-dialog__footer">
              <button type="button" className="btn-secondary" onClick={() => close(false)}>
                {options.cancelLabel ?? "取消"}
              </button>
              <button
                type="button"
                className={options.danger ? "btn btn-danger" : "btn-primary"}
                onClick={() => close(true)}
              >
                {options.confirmLabel ?? "确认"}
              </button>
            </div>
          </div>
        )}
      </ModalSurface>
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used within ConfirmProvider");
  return ctx.confirm;
}
