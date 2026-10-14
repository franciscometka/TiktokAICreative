import { describe, expect, it } from "vitest";
import { sceneDurationFrames, sceneStartFrame, sceneTimeline, secondsToFrames, totalFrames } from "./timeline";

describe("timeline (frames)", () => {
  it("converte segundos em frames arredondando ao frame mais próximo", () => {
    expect(secondsToFrames(0, 30)).toBe(0);
    expect(secondsToFrames(1, 30)).toBe(30);
    expect(secondsToFrames(2.5, 30)).toBe(75);
    expect(secondsToFrames(0.1, 30)).toBe(3);
    expect(secondsToFrames(1 / 3, 30)).toBe(10);
    expect(secondsToFrames(24, 30)).toBe(720);
  });

  it("recusa fps ou segundos inválidos", () => {
    expect(() => secondsToFrames(1, 0)).toThrow(RangeError);
    expect(() => secondsToFrames(-1, 30)).toThrow(RangeError);
    expect(() => secondsToFrames(Number.NaN, 30)).toThrow(RangeError);
  });

  it("total vem da duração do criativo (nunca zero)", () => {
    expect(totalFrames(24, 30)).toBe(720);
    expect(totalFrames(0, 30)).toBe(1);
  });

  it("não acumula erro de arredondamento", () => {
    // 7 cenas de 0.45s = 3.15s = 94.5 → 95 frames; somar frames arredondados (14 cada) daria 98.
    const tl = sceneTimeline(Array(7).fill(0.45), 3.15, 30);
    expect(tl.reduce((a, s) => a + s.durationFrames, 0)).toBe(95);
    const thirds = sceneTimeline(Array(9).fill(1 / 3), 3, 30);
    expect(thirds.reduce((a, s) => a + s.durationFrames, 0)).toBe(90);
  });

  it("cenas contíguas, sem buraco nem sobreposição, terminando no último frame", () => {
    const tl = sceneTimeline([2.7, 3.1, 4.05, 6.15, 8], 24, 30);
    expect(tl[0]?.startFrame).toBe(0);
    for (let i = 1; i < tl.length; i++) {
      expect(tl[i]?.startFrame).toBe((tl[i - 1]?.startFrame ?? 0) + (tl[i - 1]?.durationFrames ?? 0));
    }
    const last = tl[tl.length - 1]!;
    expect(last.startFrame + last.durationFrames).toBe(720);
  });

  it("a última cena absorve a diferença tolerada entre a soma das cenas e a duração final", () => {
    const tl = sceneTimeline([3, 3, 3], 9.2, 30);
    expect(tl.map((s) => s.durationFrames)).toEqual([90, 90, 96]);
  });

  it("sceneStartFrame/sceneDurationFrames leem a linha do tempo e recusam índice inexistente", () => {
    const tl = sceneTimeline([1, 2], 3, 30);
    expect(sceneStartFrame(tl, 1)).toBe(30);
    expect(sceneDurationFrames(tl, 1)).toBe(60);
    expect(() => sceneStartFrame(tl, 2)).toThrow(RangeError);
    expect(() => sceneDurationFrames(tl, -1)).toThrow(RangeError);
  });

  it("sem cenas → linha do tempo vazia", () => {
    expect(sceneTimeline([], 10, 30)).toEqual([]);
  });
});
