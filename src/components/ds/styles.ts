/**
 * L8.0 — helpers de classe do design system Cinematic AI Studio.
 * Só utilitários semânticos (bg-surface, text-fg-muted, border-line...) para que cada componente
 * funcione no tema escuro e dentro da ilha clara (`.theme-light`) sem variantes duplicadas.
 */

export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

/** Anel de foco único (teclado). */
export const focusRing = "outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-light";

/** Transição padrão de interação (cor/borda/sombra/transform, 140ms, curva da marca). */
export const interactive = "transition-[color,background-color,border-color,box-shadow,transform,opacity] duration-(--dur-fast) ease-cf";

export type Size = "sm" | "md" | "lg";
export type Tone = "neutral" | "primary" | "accent" | "success" | "warning" | "danger";
