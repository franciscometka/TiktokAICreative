import type { ReactNode } from "react";

/** Primitivos visuais compartilhados. Apenas apresentação. */

export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-zinc-900 text-white hover:bg-zinc-800 disabled:bg-zinc-300 disabled:text-zinc-500",
  secondary:
    "bg-white text-zinc-900 ring-1 ring-inset ring-zinc-300 hover:bg-zinc-50 disabled:text-zinc-400 disabled:ring-zinc-200",
  ghost: "text-zinc-700 hover:bg-zinc-100 hover:text-zinc-900 disabled:text-zinc-400",
  danger: "bg-white text-red-700 ring-1 ring-inset ring-red-200 hover:bg-red-50 disabled:text-red-300",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-[13px]",
  md: "h-9 px-4 text-sm",
  lg: "h-11 px-5 text-[15px]",
};

export function buttonClasses(variant: ButtonVariant = "primary", size: ButtonSize = "md"): string {
  return cx(
    "inline-flex shrink-0 items-center justify-center gap-2 rounded-md font-medium transition-colors",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 disabled:cursor-not-allowed",
    VARIANTS[variant],
    SIZES[size],
  );
}

export type Tone = "neutral" | "blue" | "green" | "amber" | "red" | "teal" | "sky";

const TONES: Record<Tone, string> = {
  neutral: "bg-zinc-100 text-zinc-700 ring-zinc-200",
  blue: "bg-blue-50 text-blue-700 ring-blue-200",
  green: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  amber: "bg-amber-50 text-amber-800 ring-amber-200",
  red: "bg-red-50 text-red-700 ring-red-200",
  teal: "bg-teal-50 text-teal-700 ring-teal-200",
  sky: "bg-sky-50 text-sky-700 ring-sky-200",
};

const DOTS: Record<Tone, string> = {
  neutral: "bg-zinc-400",
  blue: "bg-blue-500",
  green: "bg-emerald-500",
  amber: "bg-amber-500",
  red: "bg-red-500",
  teal: "bg-teal-500",
  sky: "bg-sky-500",
};

export function Badge({ tone = "neutral", dot, children }: { tone?: Tone; dot?: boolean; children: ReactNode }) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset",
        TONES[tone],
      )}
    >
      {dot && <span className={cx("size-1.5 rounded-full", DOTS[tone])} aria-hidden />}
      {children}
    </span>
  );
}

export function Panel({ className, children, id }: { className?: string; children: ReactNode; id?: string }) {
  return (
    <div id={id} className={cx("rounded-lg border border-zinc-200 bg-white", className)}>
      {children}
    </div>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {eyebrow && <p className="text-xs font-semibold tracking-wider text-zinc-500 uppercase">{eyebrow}</p>}
        <h2 className="mt-0.5 text-lg font-semibold tracking-tight text-zinc-900">{title}</h2>
        {description && <p className="mt-1 text-sm text-zinc-600">{description}</p>}
      </div>
      {action}
    </div>
  );
}

/** Tooltip acessível por hover e foco (sem JS). */
export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="group relative inline-flex">
      <span tabIndex={0} className="inline-flex cursor-help rounded outline-offset-2 focus-visible:outline-2" aria-label={label}>
        {children}
      </span>
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-0 z-20 mb-2 hidden w-56 rounded-md bg-zinc-900 px-3 py-2 text-xs leading-relaxed font-normal text-white shadow-lg group-focus-within:block group-hover:block"
      >
        {label}
      </span>
    </span>
  );
}

export const PLACEHOLDER_PRICE_HINT = "O provider real ainda não foi configurado. O valor pode mudar.";

/** `static`: dentro de outro elemento interativo (ex.: card-botão) — usa só `title`, sem foco próprio. */
export function ProvisionalBadge({ static: isStatic }: { static?: boolean } = {}) {
  if (isStatic) {
    return (
      <span title={PLACEHOLDER_PRICE_HINT}>
        <Badge tone="amber">Estimativa provisória</Badge>
        <span className="sr-only">. {PLACEHOLDER_PRICE_HINT}</span>
      </span>
    );
  }
  return (
    <InfoTip label={PLACEHOLDER_PRICE_HINT}>
      <Badge tone="amber">Estimativa provisória</Badge>
    </InfoTip>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cx("size-4 animate-spin", className)} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Notice({
  tone = "neutral",
  title,
  children,
  action,
}: {
  tone?: "neutral" | "amber" | "red" | "blue" | "green";
  title?: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  const styles = {
    neutral: "border-zinc-200 bg-zinc-50 text-zinc-700",
    amber: "border-amber-200 bg-amber-50 text-amber-900",
    red: "border-red-200 bg-red-50 text-red-900",
    blue: "border-blue-200 bg-blue-50 text-blue-900",
    green: "border-emerald-200 bg-emerald-50 text-emerald-900",
  }[tone];
  return (
    <div className={cx("flex flex-wrap items-start justify-between gap-3 rounded-lg border px-4 py-3 text-sm", styles)}>
      <div className="min-w-0 flex-1">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={cx("leading-relaxed", title && "mt-0.5")}>{children}</div>}
      </div>
      {action}
    </div>
  );
}

export function KeyValue({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-zinc-500">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium text-zinc-900">{children}</dd>
    </div>
  );
}
