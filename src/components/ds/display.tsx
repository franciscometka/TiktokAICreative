import type { HTMLAttributes, ReactNode } from "react";
import { cx, type Tone } from "./styles";

/**
 * Peças de exibição sem estado: Badge, Card, Skeleton, Progress, StatusDot, EmptyState, Spark e
 * AmbientGlow. Server-safe (nenhum hook).
 */

// ---------------------------------------------------------------- Spark ✦

/**
 * Assinatura visual da IA. `active` = pulso muito discreto (estados em andamento);
 * `gradient` = gradiente da marca. Decorativo: o texto ao lado carrega o significado.
 */
export function Spark({ active = false, gradient = false, className }: { active?: boolean; gradient?: boolean; className?: string }) {
  return (
    <span aria-hidden className={cx("inline-block leading-none select-none", active && "animate-spark", gradient ? "text-gradient-ai" : "text-primary-light", className)}>✦</span>
  );
}

// ---------------------------------------------------------------- Badge

const BADGE_TONE: Record<Tone | "ai", string> = {
  neutral: "bg-fg/[0.06] text-fg-muted ring-line",
  primary: "bg-primary-soft text-primary-light ring-primary/25",
  accent: "bg-accent-soft text-accent ring-accent/25",
  success: "bg-success-soft text-success ring-success/25",
  warning: "bg-warning-soft text-warning ring-warning/25",
  danger: "bg-danger-soft text-danger ring-danger/25",
  ai: "bg-primary-soft text-fg ring-primary/30",
};

export function Badge({ tone = "neutral", dot = false, className, children }: { tone?: Tone | "ai"; dot?: boolean; className?: string; children: ReactNode }) {
  return (
    <span className={cx("inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset", BADGE_TONE[tone], className)}>
      {tone === "ai" ? <Spark gradient className="text-[11px]" /> : dot ? <span aria-hidden className="size-1.5 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}

// ---------------------------------------------------------------- Card

export interface CardProps extends HTMLAttributes<HTMLElement> {
  /** Hover com elevação sutil (cards clicáveis). */
  interactive?: boolean;
  selected?: boolean;
  padding?: "none" | "sm" | "md" | "lg";
  as?: "section" | "div" | "article" | "li";
}

const PADDING = { none: "", sm: "p-4", md: "p-5 sm:p-6", lg: "p-6 sm:p-8" } as const;

export function cardClass({ interactive = false, selected = false, padding = "none" }: Pick<CardProps, "interactive" | "selected" | "padding"> = {}): string {
  return cx(
    "rounded-2xl border bg-surface shadow-raise",
    selected ? "border-primary-light/60 ring-1 ring-primary-light/40" : "border-line",
    interactive && "transition-[background-color,border-color,transform,box-shadow] duration-(--dur-normal) ease-cf hover:-translate-y-0.5 hover:border-line-strong hover:bg-surface-hover",
    PADDING[padding],
  );
}

export function Card({ interactive, selected, padding, as: Tag = "section", className, children, ...rest }: CardProps) {
  return <Tag className={cx(cardClass({ interactive, selected, padding }), className)} {...rest}>{children}</Tag>;
}

// ---------------------------------------------------------------- Skeleton

/** Placeholder com o MESMO tamanho do conteúdo final (evita CLS). Shimmer muito discreto. */
export function Skeleton({ className, rounded = "md" }: { className?: string; rounded?: "md" | "full" | "xl" }) {
  return (
    <span aria-hidden className={cx(
      "relative block overflow-hidden bg-fg/[0.05]",
      rounded === "md" ? "rounded-md" : rounded === "xl" ? "rounded-2xl" : "rounded-full",
      "after:absolute after:inset-0 after:animate-shimmer after:bg-linear-to-r after:from-transparent after:via-fg/[0.06] after:to-transparent",
      className,
    )} />
  );
}

// ---------------------------------------------------------------- Progress

/**
 * Barra de progresso. `value` 0–100 = progresso REAL; omitido = indeterminado (sem número falso).
 * Animação por `transform: scaleX`.
 */
export function Progress({ value, label, tone = "primary", size = "md", className }: { value?: number; label: string; tone?: "primary" | "ai" | "success" | "danger"; size?: "sm" | "md"; className?: string }) {
  const determinate = typeof value === "number";
  const pct = determinate ? Math.min(100, Math.max(0, value)) : 0;
  const fill = tone === "ai" ? "bg-(image:--cf-gradient-ai)" : tone === "success" ? "bg-success" : tone === "danger" ? "bg-danger" : "bg-primary-light";
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={determinate ? Math.round(pct) : undefined}
      className={cx("relative w-full overflow-hidden rounded-full bg-fg/[0.07]", size === "md" ? "h-1.5" : "h-1", className)}>
      {determinate
        ? <span className={cx("absolute inset-0 origin-left rounded-full transition-transform duration-(--dur-emph) ease-cf", fill)} style={{ transform: `scaleX(${pct / 100})` }} />
        : <span className={cx("absolute inset-y-0 left-0 w-2/5 animate-indeterminate rounded-full", fill)} />}
    </div>
  );
}

// ---------------------------------------------------------------- StatusDot

export type Status = "online" | "offline" | "busy" | "warning" | "error" | "idle";
const DOT: Record<Status, string> = {
  online: "bg-success", busy: "bg-primary-light", warning: "bg-warning", error: "bg-danger", offline: "bg-fg-subtle", idle: "bg-fg-subtle/60",
};

/** Ponto de status. `live` = anel pulsando (só para estado ativo, ex.: worker online/gerando). */
export function StatusDot({ status, live = false, label, className }: { status: Status; live?: boolean; label?: string; className?: string }) {
  return (
    <span className={cx("relative inline-flex size-2 shrink-0", className)} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      {live ? <span className={cx("absolute inset-0 animate-ping-soft rounded-full", DOT[status])} /> : null}
      <span className={cx("relative size-2 rounded-full", DOT[status])} />
    </span>
  );
}

// ---------------------------------------------------------------- EmptyState

export function EmptyState({ icon, title, description, action, className }: { icon?: ReactNode; title: string; description?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cx("flex flex-col items-center rounded-2xl border border-dashed border-line-strong px-6 py-14 text-center", className)}>
      <span className="mb-5 grid size-12 place-items-center rounded-2xl bg-primary-soft text-xl text-primary-light ring-1 ring-inset ring-primary/25 [&_svg]:size-5">
        {icon ?? <Spark gradient />}
      </span>
      <p className="text-heading font-semibold text-fg">{title}</p>
      {description ? <p className="mt-2 max-w-sm text-sm text-fg-muted">{description}</p> : null}
      {action ? <div className="mt-6">{action}</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------- AmbientGlow

/**
 * Glow ambiente (violeta/ciano) para áreas especiais: hero, geração, resultado. Gradientes
 * radiais (sem `filter: blur`, barato), opacity ~0.12, atrás do conteúdo e sem interação.
 */
export function AmbientGlow({ className }: { className?: string }) {
  return (
    <div aria-hidden className={cx("pointer-events-none absolute inset-0 -z-10 overflow-hidden", className)}>
      <div className="absolute -top-1/3 left-1/2 h-[42rem] w-[56rem] -translate-x-1/2 opacity-[0.14]"
        style={{ background: "radial-gradient(closest-side, #7c3aed, transparent), radial-gradient(closest-side at 80% 70%, #22d3ee, transparent 70%)" }} />
    </div>
  );
}
