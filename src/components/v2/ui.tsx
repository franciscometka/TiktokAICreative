import type { ReactNode } from "react";
import { cx } from "../ui/primitives";

/**
 * Design system V2 (Lote 6): SaaS criativo, claro e espaçoso. Fundo cinza sutil, cards brancos
 * com borda delicada, radius 12–16px, tipografia forte e UMA cor de destaque (`accent`, índigo).
 * Apenas apresentação; nenhuma regra de negócio.
 */

export type V2ButtonVariant = "primary" | "secondary" | "ghost" | "accent";

export function v2Button(variant: V2ButtonVariant = "primary", size: "sm" | "md" | "lg" = "md"): string {
  return cx(
    "inline-flex shrink-0 items-center justify-center gap-2 rounded-full font-medium transition",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 disabled:cursor-not-allowed disabled:opacity-50",
    variant === "primary" && "bg-zinc-950 text-white hover:bg-zinc-800",
    variant === "accent" && "bg-indigo-600 text-white hover:bg-indigo-500",
    variant === "secondary" && "bg-white text-zinc-900 ring-1 ring-inset ring-zinc-200 hover:bg-zinc-50",
    variant === "ghost" && "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900",
    size === "sm" && "h-8 px-3.5 text-[13px]",
    size === "md" && "h-10 px-5 text-sm",
    size === "lg" && "h-12 px-7 text-[15px]",
  );
}

export function Card({ className, children, id }: { className?: string; children: ReactNode; id?: string }) {
  return <section id={id} className={cx("rounded-2xl border border-zinc-200/80 bg-white shadow-[0_1px_2px_rgb(0_0_0/0.03)]", className)}>{children}</section>;
}

export function PageHeader({ title, description, action }: { title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-[28px] leading-tight font-semibold tracking-tight text-zinc-950 sm:text-[32px]">{title}</h1>
        {description ? <p className="mt-2 max-w-2xl text-[15px] text-zinc-500">{description}</p> : null}
      </div>
      {action}
    </header>
  );
}

/** Controle segmentado (ex.: 30s · 45s · 60s). */
export function Segmented<T extends string | number>({ label, options, value, onChange }: { label: string; options: readonly { value: T; label: string }[]; value: T; onChange: (value: T) => void }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-full bg-zinc-100 p-1">
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button key={String(option.value)} type="button" role="radio" aria-checked={selected} onClick={() => onChange(option.value)}
            className={cx("h-9 min-w-16 rounded-full px-4 text-sm font-medium transition", selected ? "bg-white text-zinc-950 shadow-sm" : "text-zinc-500 hover:text-zinc-900")}>
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function Chip({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "accent" | "success" | "warning" }) {
  return (
    <span className={cx(
      "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
      tone === "neutral" && "bg-zinc-100 text-zinc-600",
      tone === "accent" && "bg-indigo-50 text-indigo-700",
      tone === "success" && "bg-emerald-50 text-emerald-700",
      tone === "warning" && "bg-amber-50 text-amber-800",
    )}>{children}</span>
  );
}

export const v2Input = (invalid?: boolean) => cx(
  "block w-full rounded-xl border bg-white px-4 py-3 text-[15px] text-zinc-900 placeholder:text-zinc-400 transition",
  "focus:outline-none focus:ring-4 focus:ring-indigo-500/10",
  invalid ? "border-red-300 focus:border-red-400" : "border-zinc-200 focus:border-indigo-400",
);

export function FieldLabel({ htmlFor, children, hint }: { htmlFor?: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="mb-2 flex items-baseline justify-between gap-3">
      <label htmlFor={htmlFor} className="text-sm font-medium text-zinc-900">{children}</label>
      {hint ? <span className="text-xs text-zinc-400">{hint}</span> : null}
    </div>
  );
}

export function FieldError({ id, children }: { id?: string; children?: ReactNode }) {
  return children ? <p id={id} role="alert" className="mt-1.5 text-xs font-medium text-red-600">{children}</p> : null;
}
