"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";

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
  const [resolver, setResolver] = useState<((v: boolean) => void) | null>(null);

  const confirm = useCallback((opts: ConfirmOptions) => {
    setOptions(opts);
    setOpen(true);
    return new Promise<boolean>((resolve) => {
      setResolver(() => resolve);
    });
  }, []);

  const close = useCallback(
    (result: boolean) => {
      setOpen(false);
      resolver?.(result);
      setResolver(null);
      setOptions(null);
    },
    [resolver],
  );

  const value = useMemo(() => ({ confirm }), [confirm]);

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      {open && options && (
        <div className="modal-backdrop" onClick={() => close(false)} role="presentation">
          <div
            className="confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="confirm-title" className="confirm-dialog__title">
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
        </div>
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error("useConfirm must be used within ConfirmProvider");
  return ctx.confirm;
}
