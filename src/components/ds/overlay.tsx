"use client";

import { X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { IconButton } from "./button";
import { cx } from "./styles";

/**
 * Modal e Sheet sobre o <dialog> nativo: top layer, foco preso, Esc fecha e o foco volta para
 * quem abriu (comportamento do navegador). Clique no fundo fecha. Entrada com scale/slide
 * (transform + opacity); reduced motion desliga.
 */

interface OverlayProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
}

function useDialog(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      // Foco inicial no conteúdo (primeiro campo/ação), não no botão "Fechar" do cabeçalho.
      dialog.querySelector<HTMLElement>("[data-autofocus], [data-overlay-body] :is(input, textarea, select, button, a[href])")?.focus();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const onCancel = (event: Event) => { event.preventDefault(); onClose(); };
    dialog.addEventListener("cancel", onCancel);
    return () => dialog.removeEventListener("cancel", onCancel);
  }, [onClose]);
  return ref;
}

function Header({ titleId, descId, title, description, onClose }: { titleId: string; descId: string; title: ReactNode; description?: ReactNode; onClose: () => void }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h2 id={titleId} className="text-heading font-semibold text-fg">{title}</h2>
        {description ? <p id={descId} className="mt-1 text-sm text-fg-muted">{description}</p> : null}
      </div>
      <IconButton label="Fechar" size="sm" onClick={onClose} className="-mt-1 -mr-1"><X /></IconButton>
    </div>
  );
}

export function Modal({ open, onClose, title, description, children, footer, size = "md", className }: OverlayProps & { size?: "sm" | "md" | "lg" }) {
  const ref = useDialog(open, onClose);
  const titleId = useId();
  const descId = useId();
  return (
    <dialog ref={ref} aria-labelledby={titleId} aria-describedby={description ? descId : undefined}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      className={cx(
        "cf-overlay m-auto w-[calc(100%-2rem)] rounded-2xl border border-line-strong bg-elevated p-0 text-fg shadow-pop open:animate-scale-in",
        size === "sm" ? "max-w-sm" : size === "md" ? "max-w-lg" : "max-w-2xl",
        className,
      )}>
      {open ? (
        <div className="p-6">
          <Header titleId={titleId} descId={descId} title={title} description={description} onClose={onClose} />
          {children ? <div data-overlay-body className="mt-5">{children}</div> : null}
          {footer ? <div data-overlay-body className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">{footer}</div> : null}
        </div>
      ) : null}
    </dialog>
  );
}

/** Painel lateral (desktop, à direita) que vira bottom sheet no mobile. */
export function Sheet({ open, onClose, title, description, children, footer, className }: OverlayProps) {
  const ref = useDialog(open, onClose);
  const titleId = useId();
  const descId = useId();
  return (
    <dialog ref={ref} aria-labelledby={titleId} aria-describedby={description ? descId : undefined}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      className={cx(
        "cf-overlay fixed m-0 max-w-full border-line-strong bg-elevated p-0 text-fg shadow-pop",
        // Mobile: bottom sheet. Desktop: painel à direita, altura total.
        "inset-x-0 top-auto bottom-0 max-h-[85dvh] w-full rounded-t-2xl border-t open:animate-sheet-up",
        "sm:inset-y-0 sm:right-0 sm:left-auto sm:h-dvh sm:max-h-dvh sm:w-[26rem] sm:rounded-none sm:border-t-0 sm:border-l sm:open:animate-sheet-right",
        className,
      )}>
      {open ? (
        <div className="flex max-h-[85dvh] flex-col sm:h-full sm:max-h-none">
          <div className="mx-auto mt-2.5 h-1 w-10 rounded-full bg-fg/15 sm:hidden" aria-hidden />
          <div className="border-b border-line px-6 py-5"><Header titleId={titleId} descId={descId} title={title} description={description} onClose={onClose} /></div>
          <div data-overlay-body className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
          {footer ? <div data-overlay-body className="flex gap-2 border-t border-line px-6 py-4 sm:justify-end">{footer}</div> : null}
        </div>
      ) : null}
    </dialog>
  );
}
