/**
 * Cálculo PURO de frames. Regras:
 * - A posição de cada cena vem da soma ACUMULADA das durações em milissegundos inteiros,
 *   arredondada uma única vez para frame — nunca somamos frames arredondados (erro acumulado).
 * - O total vem da duração do criativo. A última cena termina exatamente no último frame
 *   (absorve a diferença de até DURATION_TOLERANCE_SECONDS permitida pelo domínio).
 */

export interface SceneFrames {
  startFrame: number;
  durationFrames: number;
}

const toMs = (seconds: number) => Math.round(seconds * 1000);

/** Segundos → frames, arredondando para o frame mais próximo (via ms inteiros). */
export function secondsToFrames(seconds: number, fps: number): number {
  if (!(fps > 0)) throw new RangeError(`fps inválido: ${fps}`);
  if (!(seconds >= 0)) throw new RangeError(`segundos inválidos: ${seconds}`);
  return Math.round((toMs(seconds) * fps) / 1000);
}

export function totalFrames(durationSeconds: number, fps: number): number {
  return Math.max(1, secondsToFrames(durationSeconds, fps));
}

/** Linha do tempo das cenas, sem buracos nem sobreposição, terminando em totalFrames. */
export function sceneTimeline(sceneDurations: readonly number[], totalSeconds: number, fps: number): SceneFrames[] {
  if (sceneDurations.length === 0) return [];
  const total = totalFrames(totalSeconds, fps);
  let cumulativeMs = 0;
  const starts = sceneDurations.map((d) => {
    const start = Math.round((cumulativeMs * fps) / 1000);
    cumulativeMs += toMs(d);
    return Math.min(start, total - 1);
  });
  return starts.map((start, i) => {
    const end = i === starts.length - 1 ? total : (starts[i + 1] ?? total);
    return { startFrame: start, durationFrames: Math.max(1, end - start) };
  });
}

export function sceneStartFrame(timeline: readonly SceneFrames[], index: number): number {
  const scene = timeline[index];
  if (!scene) throw new RangeError(`Cena ${index} fora da linha do tempo`);
  return scene.startFrame;
}

export function sceneDurationFrames(timeline: readonly SceneFrames[], index: number): number {
  const scene = timeline[index];
  if (!scene) throw new RangeError(`Cena ${index} fora da linha do tempo`);
  return scene.durationFrames;
}
