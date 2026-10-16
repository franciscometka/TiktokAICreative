import { describe, expect, it } from "vitest";
import { SIMPLE_QUALITY_PRESETS } from "./simple-presets";

describe("presets do fluxo simples", () => {
  it("usa as três faixas de duração aprovadas", () => {
    expect(SIMPLE_QUALITY_PRESETS.economy.finalVideoSeconds).toEqual({ min: 15, max: 20 });
    expect(SIMPLE_QUALITY_PRESETS.high.finalVideoSeconds).toEqual({ min: 20, max: 30 });
    expect(SIMPLE_QUALITY_PRESETS.high.label).toBe("Equilibrado");
    expect(SIMPLE_QUALITY_PRESETS.premium.finalVideoSeconds).toEqual({ min: 30, max: 45 });
  });

  it("reserva progressivamente mais vídeo gerado", () => {
    expect(SIMPLE_QUALITY_PRESETS.economy.generatedVideoSeconds.max).toBeLessThan(SIMPLE_QUALITY_PRESETS.high.generatedVideoSeconds.max);
    expect(SIMPLE_QUALITY_PRESETS.high.generatedVideoSeconds.max).toBeLessThan(SIMPLE_QUALITY_PRESETS.premium.generatedVideoSeconds.max);
  });
});
