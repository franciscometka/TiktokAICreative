/**
 * Lote 6 — durações do fluxo V2 (30/45/60s). Palavras são GUIDANCE (fala natural pt-BR ≈ 2,4–2,7
 * palavras/s), não regra de uma palavra: a validação tolera ±15% antes de pedir nova tentativa paga.
 * Trechos ≤ 8s (Veo gera 8s); o uso real por trecho fica ~7s depois dos handles.
 */
export const TARGET_DURATIONS = [30, 45, 60] as const;
export type TargetDuration = (typeof TARGET_DURATIONS)[number];

export interface DurationTarget {
  seconds: TargetDuration;
  label: string;
  words: { min: number; max: number };
  /** Trechos da apresentadora (A-rolls). */
  clips: number;
  /** Duração editorial planejada de cada trecho. */
  clipSeconds: number;
  finalVideoSeconds: { min: number; max: number };
}

export const DURATION_TARGETS: Record<TargetDuration, DurationTarget> = {
  30: { seconds: 30, label: "30s", words: { min: 70, max: 90 }, clips: 5, clipSeconds: 6.6, finalVideoSeconds: { min: 30, max: 36 } },
  45: { seconds: 45, label: "45s", words: { min: 100, max: 125 }, clips: 7, clipSeconds: 6.7, finalVideoSeconds: { min: 44, max: 50 } },
  60: { seconds: 60, label: "60s", words: { min: 130, max: 160 }, clips: 9, clipSeconds: 6.8, finalVideoSeconds: { min: 58, max: 64 } },
};

/** Tolerância antes de recusar o roteiro (evita nova chamada paga por diferença pequena). */
export const WORD_TOLERANCE = 0.15;

export function isTargetDuration(value: unknown): value is TargetDuration {
  return (TARGET_DURATIONS as readonly unknown[]).includes(value);
}

export function wordWindow(target: DurationTarget): { min: number; max: number } {
  return { min: Math.floor(target.words.min * (1 - WORD_TOLERANCE)), max: Math.ceil(target.words.max * (1 + WORD_TOLERANCE)) };
}
