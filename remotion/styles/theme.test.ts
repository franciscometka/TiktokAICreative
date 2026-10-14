import { describe, expect, it } from "vitest";
import { CANVAS, LAYOUT, SAFE_AREA, SAFE_BOX } from "./theme";

describe("safe areas", () => {
  it("canvas vertical 1080x1920", () => {
    expect(CANVAS).toEqual({ width: 1080, height: 1920 });
  });

  it("safe box = canvas menos as faixas cobertas pela interface", () => {
    expect(SAFE_BOX).toEqual({ x: 72, y: 200, width: 1080 - 72 - 180, height: 1920 - 200 - 440 });
    // A coluna de botões fica à direita: margem direita maior que a esquerda.
    expect(SAFE_AREA.right).toBeGreaterThan(SAFE_AREA.left);
  });

  it("textos posicionados dentro da safe box", () => {
    const safeBottom = CANVAS.height - SAFE_AREA.bottom;
    for (const top of [LAYOUT.hookTop, LAYOUT.sceneTextTop, LAYOUT.placeholderLabelTop]) {
      expect(top).toBeGreaterThanOrEqual(SAFE_AREA.top);
      expect(top).toBeLessThan(safeBottom);
    }
    expect(LAYOUT.captionBottom).toBeLessThanOrEqual(safeBottom);
    expect(LAYOUT.ctaBottom).toBeLessThanOrEqual(safeBottom);
    expect(LAYOUT.captionBottom).toBeGreaterThan(SAFE_AREA.top);
  });
});
