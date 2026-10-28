"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cx, focusRing, interactive } from "./styles";

const iconTriggerClass = cx(
  "inline-flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-surface text-fg ring-1 ring-inset ring-line-strong hover:bg-surface-hover",
  "active:scale-[0.94] aria-expanded:bg-surface-hover [&_svg]:size-[18px]", interactive, focusRing,
);

/**
 * Menu de ações (role=menu). Teclado: setas, Home/End, Enter/Espaço, Esc (volta o foco ao gatilho),
 * Tab fecha. Clique fora fecha. Um único listener global, só enquanto aberto.
 */

export interface DropdownItem {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  tone?: "default" | "danger";
  disabled?: boolean;
  /** Linha separadora antes do item. */
  separated?: boolean;
}

/**
 * O gatilho é renderizado aqui (aria-haspopup/expanded/controls garantidos). `triggerClassName`
 * recebe `buttonClass(...)` ou estilo de IconButton; `triggerLabel` é o nome acessível.
 */
export function Dropdown({ trigger, triggerLabel, triggerClassName, items, align = "end", label, className }: {
  trigger: ReactNode;
  triggerLabel?: string;
  triggerClassName?: string;
  items: readonly DropdownItem[];
  align?: "start" | "end";
  label: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const menuId = useId();
  /** Item a focar quando o menu acabar de abrir (aplicado no effect, após o commit). */
  const pendingFocus = useRef<"first" | "last" | null>(null);

  const enabled = items.map((item, i) => (item.disabled ? -1 : i)).filter((i) => i >= 0);
  const focusItem = (i: number | undefined) => { if (i !== undefined) itemRefs.current[i]?.focus(); };

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  function close(refocus: boolean) {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }

  function openAt(position: "first" | "last") {
    pendingFocus.current = position;
    setOpen(true);
  }

  useEffect(() => {
    if (!open || !pendingFocus.current) return;
    const ids = items.map((item, i) => (item.disabled ? -1 : i)).filter((i) => i >= 0);
    itemRefs.current[(pendingFocus.current === "first" ? ids[0] : ids.at(-1)) ?? -1]?.focus();
    pendingFocus.current = null;
  }, [open, items]);

  function onMenuKeyDown(event: KeyboardEvent) {
    const current = enabled.indexOf(itemRefs.current.findIndex((el) => el === document.activeElement));
    if (event.key === "ArrowDown") { event.preventDefault(); focusItem(enabled[(current + 1) % enabled.length]); }
    else if (event.key === "ArrowUp") { event.preventDefault(); focusItem(enabled[(current - 1 + enabled.length) % enabled.length]); }
    else if (event.key === "Home") { event.preventDefault(); focusItem(enabled[0]); }
    else if (event.key === "End") { event.preventDefault(); focusItem(enabled.at(-1)); }
    else if (event.key === "Escape") { event.preventDefault(); close(true); }
    else if (event.key === "Tab") close(false);
  }

  return (
    <div ref={root} className={cx("relative inline-flex", className)}>
      <button ref={triggerRef} type="button" aria-label={triggerLabel} title={triggerLabel} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
        className={triggerClassName ?? iconTriggerClass} onClick={() => (open ? close(false) : openAt("first"))}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") { event.preventDefault(); openAt("first"); }
          if (event.key === "ArrowUp") { event.preventDefault(); openAt("last"); }
        }}>
        {trigger}
      </button>
      {open ? (
        <div id={menuId} role="menu" aria-label={label} onKeyDown={onMenuKeyDown}
          className={cx(
            "absolute top-full z-50 mt-2 min-w-48 origin-top animate-scale-in rounded-xl border border-line-strong bg-elevated p-1 shadow-pop",
            align === "end" ? "right-0 origin-top-right" : "left-0 origin-top-left",
          )}>
          {items.map((item, i) => (
            <div key={item.label}>
              {item.separated ? <div role="separator" className="my-1 h-px bg-line" /> : null}
              <button ref={(el) => { itemRefs.current[i] = el; }} type="button" role="menuitem" tabIndex={-1} disabled={item.disabled}
                onClick={() => { close(true); item.onSelect(); }}
                className={cx(
                  "flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm transition-colors duration-(--dur-fast)", focusRing,
                  "focus-visible:outline-offset-0 disabled:cursor-not-allowed disabled:opacity-40 [&_svg]:size-4 [&_svg]:shrink-0",
                  item.tone === "danger" ? "text-danger hover:bg-danger-soft focus:bg-danger-soft" : "text-fg hover:bg-surface-hover focus:bg-surface-hover [&_svg]:text-fg-muted",
                )}>
                {item.icon}{item.label}
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
