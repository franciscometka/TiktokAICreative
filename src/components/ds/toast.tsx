"use client";

import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cx, focusRing } from "./styles";
import { DEFAULT_TOAST_MS, pushToast, ToastClock, type ToastInput, type ToastItem, type ToastTone } from "./toast-model";

/**
 * Toasts: `ToastProvider` + `useToast().show(...)`. aria-live (polite; erro = assertive), no máximo
 * 3 visíveis, dedupe por `id` (sem spam do mesmo evento), some em 5s e pausa com hover/foco.
 * L8.8: regras em `toast-model` (testadas); `useOptionalToast` não exige o provider.
 */

export type { ToastInput, ToastTone } from "./toast-model";

type ToastApi = { show: (toast: ToastInput) => void; dismiss: (id: string) => void };
const ToastCtx = createContext<ToastApi | null>(null);
const NOOP: ToastApi = { show: () => undefined, dismiss: () => undefined };

export function useToast() {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error("useToast precisa de <ToastProvider>.");
  return ctx;
}

/** Mesmo que `useToast`, mas sem provider (testes, ilhas isoladas) vira no-op. */
export function useOptionalToast(): ToastApi {
  return useContext(ToastCtx) ?? NOOP;
}

const ICON: Record<ToastTone, ReactNode> = {
  success: <CheckCircle2 className="text-success" />,
  info: <Info className="text-primary-light" />,
  warning: <AlertTriangle className="text-warning" />,
  danger: <XCircle className="text-danger" />,
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: string) => setToasts((all) => all.filter((t) => t.id !== id)), []);
  const show = useCallback((input: ToastInput) => {
    const fallback = `t${++seq.current}`;
    setToasts((all) => pushToast(all, input, fallback));
  }, []);
  const value = useMemo(() => ({ show, dismiss }), [show, dismiss]);
  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed inset-x-4 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-[60] flex flex-col items-center gap-2 sm:inset-x-auto sm:right-6 sm:bottom-6 sm:items-end lg:bottom-6" data-toasts>
        <div role="status" aria-live="polite" className="contents">
          {toasts.filter((t) => t.tone !== "danger").map((t) => <Toast key={t.id} toast={t} onDismiss={dismiss} />)}
        </div>
        <div role="alert" aria-live="assertive" className="contents">
          {toasts.filter((t) => t.tone === "danger").map((t) => <Toast key={t.id} toast={t} onDismiss={dismiss} />)}
        </div>
      </div>
    </ToastCtx.Provider>
  );
}

function Toast({ toast, onDismiss }: { toast: ToastItem; onDismiss: (id: string) => void }) {
  const clock = useRef<ToastClock | null>(null);
  useEffect(() => {
    const c = new ToastClock(toast.durationMs ?? DEFAULT_TOAST_MS, () => onDismiss(toast.id));
    clock.current = c;
    c.start();
    return () => c.stop();
  }, [toast, onDismiss]);
  const pause = () => clock.current?.pause();
  const resume = () => clock.current?.start();
  return (
    <div onMouseEnter={pause} onMouseLeave={resume} onFocus={pause} onBlur={resume} data-toast={toast.tone}
      className="pointer-events-auto flex w-full animate-fade-up items-start gap-3 rounded-xl border border-line-strong bg-elevated p-3.5 pr-2.5 shadow-pop sm:w-[22rem] [&>svg]:mt-0.5 [&>svg]:size-[18px] [&>svg]:shrink-0">
      {ICON[toast.tone]}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-fg">{toast.title}</p>
        {toast.description ? <p className="mt-0.5 text-caption text-fg-muted">{toast.description}</p> : null}
        {toast.action ? (
          <button type="button" onClick={() => { toast.action!.onClick(); onDismiss(toast.id); }}
            className={cx("mt-2 rounded-md text-[13px] font-medium text-primary-light hover:text-fg", focusRing)}>{toast.action.label}</button>
        ) : null}
      </div>
      <button type="button" aria-label="Fechar aviso" onClick={() => onDismiss(toast.id)}
        className={cx("grid size-7 shrink-0 place-items-center rounded-md text-fg-subtle transition-colors hover:bg-surface-hover hover:text-fg [&_svg]:size-4", focusRing)}><X /></button>
    </div>
  );
}
