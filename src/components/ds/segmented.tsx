"use client";

import { useRef, type KeyboardEvent } from "react";
import { cx, focusRing, interactive } from "./styles";

/**
 * Controle segmentado (30s · 45s · 60s). radiogroup com setas/Home/End; o indicador desliza com
 * `transform` (opções de mesma largura).
 */
export function Segmented<T extends string | number>({ label, options, value, onChange, size = "md", className }: {
  label: string;
  options: readonly { value: T; label: string; disabled?: boolean }[];
  value: T;
  onChange: (value: T) => void;
  size?: "sm" | "md";
  className?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const index = Math.max(0, options.findIndex((o) => o.value === value));

  function onKeyDown(event: KeyboardEvent) {
    const enabled = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);
    const pos = enabled.indexOf(index);
    const next =
      event.key === "ArrowRight" || event.key === "ArrowDown" ? enabled[(pos + 1) % enabled.length]
      : event.key === "ArrowLeft" || event.key === "ArrowUp" ? enabled[(pos - 1 + enabled.length) % enabled.length]
      : event.key === "Home" ? enabled[0]
      : event.key === "End" ? enabled.at(-1)
      : undefined;
    if (next === undefined) return;
    event.preventDefault();
    onChange(options[next]!.value);
    refs.current[next]?.focus();
  }

  return (
    <div role="radiogroup" aria-label={label} onKeyDown={onKeyDown}
      className={cx("relative inline-grid rounded-[10px] bg-surface-sunken p-1 ring-1 ring-inset ring-line", className)}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      <span aria-hidden className="absolute top-1 bottom-1 left-1 rounded-[7px] bg-surface-hover shadow-raise ring-1 ring-line-strong transition-transform duration-(--dur-normal) ease-cf"
        style={{ width: `calc((100% - 0.5rem) / ${options.length})`, transform: `translateX(${index * 100}%)` }} />
      {options.map((option, i) => {
        const selected = i === index;
        return (
          <button key={String(option.value)} ref={(el) => { refs.current[i] = el; }} type="button" role="radio" aria-checked={selected}
            tabIndex={selected ? 0 : -1} disabled={option.disabled} onClick={() => onChange(option.value)}
            className={cx(
              "relative z-10 rounded-[7px] px-4 font-medium", interactive, focusRing,
              size === "md" ? "h-9 min-w-16 text-sm" : "h-7 min-w-12 text-[13px]",
              selected ? "text-fg" : "text-fg-muted hover:text-fg",
              "disabled:cursor-not-allowed disabled:opacity-40",
            )}>
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
