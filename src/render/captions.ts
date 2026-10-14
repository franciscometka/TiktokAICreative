import type { ManifestCaption } from "@/domain/render";

/**
 * Legendas a partir da narração planejada. Sem áudio real não há timing palavra a palavra,
 * então a narração da cena é quebrada em trechos curtos e distribuída de forma DETERMINÍSTICA
 * na duração da cena (proporcional ao número de caracteres de cada trecho).
 */

export const CAPTION_LIMITS = {
  /** Cabe em até 2 linhas na largura útil com o tamanho de fonte do tema. */
  maxChars: 30,
  maxWords: 6,
  /** Tempo mínimo de leitura por trecho; trechos mais curtos que isso são agrupados. */
  minSeconds: 0.6,
} as const;

const BREAK_AFTER = /[.!?;:,…]$/;

export function splitNarration(text: string, limits = CAPTION_LIMITS): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const chunks: string[] = [];
  let current: string[] = [];
  const length = (ws: string[]) => ws.join(" ").length;

  for (const word of words) {
    const next = [...current, word];
    if (current.length > 0 && (length(next) > limits.maxChars || next.length > limits.maxWords)) {
      chunks.push(current.join(" "));
      current = [word];
    } else {
      current = next;
    }
    if (current.length >= 2 && BREAK_AFTER.test(word)) {
      chunks.push(current.join(" "));
      current = [];
    }
  }
  if (current.length > 0) chunks.push(current.join(" "));
  return chunks;
}

/** Junta trechos até cada um ter pelo menos minSeconds na duração disponível. */
function mergeShort(chunks: string[], durationSeconds: number, minSeconds: number): string[] {
  const maxChunks = Math.max(1, Math.floor(durationSeconds / minSeconds));
  const result = [...chunks];
  while (result.length > maxChunks) {
    // Junta o par vizinho mais curto.
    let best = 0;
    for (let i = 1; i < result.length - 1; i++) {
      if ((result[i] ?? "").length + (result[i + 1] ?? "").length < (result[best] ?? "").length + (result[best + 1] ?? "").length) {
        best = i;
      }
    }
    result.splice(best, 2, `${result[best]} ${result[best + 1]}`);
  }
  return result;
}

export function segmentNarration(
  text: string,
  startSeconds: number,
  endSeconds: number,
  limits = CAPTION_LIMITS,
): ManifestCaption[] {
  const duration = endSeconds - startSeconds;
  if (duration <= 0 || text.trim() === "") return [];
  const chunks = mergeShort(splitNarration(text, limits), duration, limits.minSeconds);
  const weights = chunks.map((c) => c.length + 4);
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  let elapsed = 0;
  return chunks.map((chunk, i) => {
    const start = startSeconds + (duration * elapsed) / totalWeight;
    elapsed += weights[i] ?? 0;
    const end = i === chunks.length - 1 ? endSeconds : startSeconds + (duration * elapsed) / totalWeight;
    return { text: chunk, startSeconds: round3(start), endSeconds: round3(end) };
  });
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
