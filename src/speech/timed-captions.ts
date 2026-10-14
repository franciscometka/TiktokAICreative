import type { TimedCaption, TimedWord } from "@/domain/audio";
import { CAPTION_LIMITS } from "@/render/captions";

/**
 * Legendas com timing REAL da fala: agrupa palavras com os mesmos limites do Lote 3
 * (≤30 caracteres, ≤6 palavras, quebra depois de pontuação). Cada trecho começa quando a
 * primeira palavra começa e fica na tela até o próximo trecho (ou um tempo mínimo de leitura).
 * Sem karaokê: a legenda é por trecho, não por palavra.
 */

const BREAK_AFTER = /[.!?;:,…]["”»)]*$/;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function groupWords(words: readonly TimedWord[], limits = CAPTION_LIMITS): TimedWord[][] {
  const groups: TimedWord[][] = [];
  let current: TimedWord[] = [];
  const text = (ws: TimedWord[]) => ws.map((w) => w.text).join(" ");
  for (const word of words) {
    const next = [...current, word];
    const sceneChanged = current.length > 0 && current[0]?.sceneId !== word.sceneId;
    if (current.length > 0 && (sceneChanged || text(next).length > limits.maxChars || next.length > limits.maxWords)) {
      groups.push(current);
      current = [word];
    } else {
      current = next;
    }
    if (current.length >= 2 && BREAK_AFTER.test(word.text)) {
      groups.push(current);
      current = [];
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

export function captionsFromWords(words: readonly TimedWord[], limits = CAPTION_LIMITS): TimedCaption[] {
  const groups = groupWords(words, limits);
  return groups.map((group, i) => {
    const first = group[0]!;
    const last = group[group.length - 1]!;
    const nextStart = groups[i + 1]?.[0]?.startSeconds;
    const readable = Math.max(last.endSeconds, first.startSeconds + limits.minSeconds);
    const end = nextStart !== undefined ? Math.min(readable, nextStart) : readable;
    return {
      text: group.map((w) => w.text).join(" "),
      startSeconds: round3(first.startSeconds),
      endSeconds: round3(Math.max(end, first.startSeconds + 0.05)),
    };
  });
}
