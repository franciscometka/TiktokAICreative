import { describe, expect, it } from "vitest";
import { CAPTION_LIMITS, segmentNarration, splitNarration } from "./captions";

const NARRATION = "Sua água esquenta antes do almoço? Essa garrafa tem parede dupla de inox e segura o gelo por até 12 horas.";

describe("legendas a partir da narração", () => {
  it("quebra em trechos curtos respeitando limites de caracteres e palavras", () => {
    const chunks = splitNarration(NARRATION);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(CAPTION_LIMITS.maxChars);
      expect(c.split(" ").length).toBeLessThanOrEqual(CAPTION_LIMITS.maxWords);
    }
    expect(chunks.join(" ")).toBe(NARRATION);
  });

  it("quebra depois de pontuação", () => {
    expect(splitNarration("Gelada o dia todo. Leve e resistente.")).toEqual(["Gelada o dia todo.", "Leve e resistente."]);
  });

  it("é determinística", () => {
    expect(segmentNarration(NARRATION, 0, 6)).toEqual(segmentNarration(NARRATION, 0, 6));
  });

  it("distribui na janela da cena, contígua, do início ao fim exato", () => {
    const caps = segmentNarration(NARRATION, 2, 8);
    expect(caps[0]?.startSeconds).toBe(2);
    expect(caps[caps.length - 1]?.endSeconds).toBe(8);
    for (let i = 1; i < caps.length; i++) expect(caps[i]?.startSeconds).toBe(caps[i - 1]?.endSeconds);
    for (const c of caps) expect(c.endSeconds).toBeGreaterThan(c.startSeconds);
  });

  it("agrupa trechos para respeitar o tempo mínimo de leitura em cena curta", () => {
    const caps = segmentNarration(NARRATION, 0, 1.5);
    expect(caps.length).toBeLessThanOrEqual(Math.floor(1.5 / CAPTION_LIMITS.minSeconds));
    expect(caps.map((c) => c.text).join(" ")).toBe(NARRATION);
  });

  it("palavra gigante não quebra o algoritmo (vira trecho próprio)", () => {
    const long = "a".repeat(100);
    expect(splitNarration(`olha ${long} aqui`)).toEqual(["olha", long, "aqui"]);
  });

  it("texto vazio ou janela inválida → sem legenda", () => {
    expect(segmentNarration("   ", 0, 3)).toEqual([]);
    expect(segmentNarration(NARRATION, 3, 3)).toEqual([]);
  });
});
