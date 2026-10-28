import type { ReactNode } from "react";
import { Badge, buttonClass, Card as DsCard, cx, inputClass, type ButtonVariant } from "../ds";

/**
 * Design system V2 — desde o L8.0 é uma camada fina sobre `@/components/ds` (Cinematic AI Studio).
 * As telas V2 continuam importando daqui; os valores vêm dos tokens semânticos, então funcionam
 * no tema escuro e dentro da ilha clara (`.theme-light`). Apenas apresentação; nenhuma regra.
 */

export { Segmented } from "../ds";

export type V2ButtonVariant = "primary" | "secondary" | "ghost" | "accent";

const V2_TO_DS: Record<V2ButtonVariant, ButtonVariant> = { primary: "primary", accent: "primary", secondary: "secondary", ghost: "ghost" };

export function v2Button(variant: V2ButtonVariant = "primary", size: "sm" | "md" | "lg" = "md"): string {
  return buttonClass({ variant: V2_TO_DS[variant], size });
}

export function Card({ className, children, id }: { className?: string; children: ReactNode; id?: string }) {
  return <DsCard id={id} className={className}>{children}</DsCard>;
}

export function PageHeader({ title, description, action }: { title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-[28px] leading-tight font-semibold tracking-tight text-fg sm:text-[32px]">{title}</h1>
        {description ? <p className="mt-2 max-w-2xl text-body text-fg-muted">{description}</p> : null}
      </div>
      {action}
    </header>
  );
}

export function Chip({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "accent" | "success" | "warning" }) {
  return <Badge tone={tone === "accent" ? "primary" : tone}>{children}</Badge>;
}

export const v2Input = (invalid?: boolean) => cx(inputClass({ invalid, size: "lg" }));

export function FieldLabel({ htmlFor, children, hint }: { htmlFor?: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="mb-2 flex items-baseline justify-between gap-3">
      <label htmlFor={htmlFor} className="text-sm font-medium text-fg">{children}</label>
      {hint ? <span className="text-caption text-fg-subtle">{hint}</span> : null}
    </div>
  );
}

export function FieldError({ id, children }: { id?: string; children?: ReactNode }) {
  return children ? <p id={id} role="alert" className="mt-1.5 text-caption font-medium text-danger">{children}</p> : null;
}
