/**
 * L8.8 — regras dos toasts, sem React (testáveis em Node): dedupe por `id` (o mesmo evento
 * substitui, não empilha), no máximo `MAX_TOASTS` visíveis e um relógio que PAUSA no hover/foco
 * e retoma com o tempo que faltava.
 */

export type ToastTone = "success" | "info" | "warning" | "danger";
export interface ToastInput {
  /** Mesmo id substitui o toast anterior em vez de empilhar. */
  id?: string;
  title: string;
  description?: string;
  tone?: ToastTone;
  action?: { label: string; onClick: () => void };
  durationMs?: number;
}
export interface ToastItem extends ToastInput { id: string; tone: ToastTone }

export const MAX_TOASTS = 3;
export const DEFAULT_TOAST_MS = 5000;

export function pushToast(list: readonly ToastItem[], input: ToastInput, fallbackId: string): ToastItem[] {
  const id = input.id ?? fallbackId;
  return [...list.filter((t) => t.id !== id), { ...input, id, tone: input.tone ?? "info" }].slice(-MAX_TOASTS);
}

/** Relógio de um toast: some após `duration`, pausa sem perder o tempo restante. */
export class ToastClock {
  private remaining: number;
  private startedAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(duration: number, private readonly onDone: () => void, private readonly now: () => number = () => Date.now()) {
    this.remaining = duration;
  }
  start(): void {
    if (this.timer) return;
    this.startedAt = this.now();
    this.timer = setTimeout(() => { this.timer = null; this.onDone(); }, this.remaining);
  }
  pause(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.remaining = Math.max(0, this.remaining - (this.now() - this.startedAt));
  }
  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
