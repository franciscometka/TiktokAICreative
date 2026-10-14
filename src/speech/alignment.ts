import type { CharacterTiming, NarrationTiming, SceneSpeechWindow, TimedWord } from "@/domain/audio";
import type { NarrationScript } from "./narration-script";

/**
 * Timing por caractere (do texto FALADO) → palavras ESCRITAS com tempo real.
 * Se o alinhamento não corresponder ao texto enviado, lança AlignmentMismatchError e quem chamou
 * cai para as legendas estimadas do Lote 3 (nunca inventa timing).
 */

export class AlignmentMismatchError extends Error {
  override name = "AlignmentMismatchError";
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function wordsFromAlignment(script: NarrationScript, timing: CharacterTiming): TimedWord[] {
  const aligned = timing.characters.join("");
  if (aligned !== script.spoken) {
    throw new AlignmentMismatchError(
      `Alinhamento não corresponde ao texto enviado (${aligned.length} × ${script.spoken.length} caracteres)`,
    );
  }
  let previousEnd = 0;
  return script.tokens.map((token) => {
    let start = Number.POSITIVE_INFINITY;
    let end = 0;
    for (let i = token.spokenStart; i < token.spokenEnd; i++) {
      if (/\s/.test(script.spoken[i] ?? "")) continue;
      start = Math.min(start, timing.startSeconds[i] ?? start);
      end = Math.max(end, timing.endSeconds[i] ?? end);
    }
    if (!Number.isFinite(start)) start = previousEnd;
    // Monotônico: nunca volta no tempo (proteção contra ruído do alinhamento).
    start = Math.max(start, previousEnd);
    end = Math.max(end, start);
    previousEnd = end;
    return { text: token.written, startSeconds: round3(start), endSeconds: round3(end), sceneId: token.sceneId };
  });
}

export function sceneWindows(words: readonly TimedWord[]): SceneSpeechWindow[] {
  const windows = new Map<string, SceneSpeechWindow>();
  for (const w of words) {
    if (!w.sceneId) continue;
    const current = windows.get(w.sceneId);
    windows.set(
      w.sceneId,
      current
        ? { ...current, endSeconds: Math.max(current.endSeconds, w.endSeconds) }
        : { sceneId: w.sceneId, startSeconds: w.startSeconds, endSeconds: w.endSeconds },
    );
  }
  return [...windows.values()];
}

export function narrationTiming(script: NarrationScript, timing: CharacterTiming): NarrationTiming {
  const words = wordsFromAlignment(script, timing);
  return {
    source: "alignment",
    words,
    scenes: sceneWindows(words),
    speechEndSeconds: words.reduce((max, w) => Math.max(max, w.endSeconds), 0),
  };
}
