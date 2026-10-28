import { describe, expect, it } from "vitest";
import { parseChangeRequest } from "./change-request";

const costs = { clipBrl: 4, clips: 5, narrationBrl: 0, scriptBrl: 0.5, referenceBrl: 0.4 };

describe("ChangeRequest — edição por texto (Lote 6)", () => {
  it.each([
    ["Deixe mais animado", "tone"],
    ["Troque o CTA", "cta"],
    ["Faça ela falar mais devagar", "voice_speed"],
    ["Quero 45 segundos", "duration"],
    ["Mude o ambiente", "environment"],
    ["Use a Marina", "avatar"],
  ])("%s → %s", (text, type) => {
    const change = parseChangeRequest(text, costs);
    expect(change.type).toBe(type);
    expect(change.affectedAssets.length).toBeGreaterThan(0);
    expect(change.instructions).toBe(text);
  });

  it("mostra custo estimado ANTES de gastar e não executa sozinho", () => {
    const cta = parseChangeRequest("Troque o CTA", costs);
    expect(cta).toMatchObject({ scope: "final_segment", executable: false, estimatedCost: { clipsToRegenerate: 1, brl: 4.5 } });
    expect(cta.estimatedCost.label).toBe("Estimativa: R$ 4,50 (1 trecho novo)");
    const duration = parseChangeRequest("Quero 60s", costs);
    expect(duration.params.durationSeconds).toBe(60);
    expect(duration.estimatedCost.clipsToRegenerate).toBe(10);
    expect(parseChangeRequest("Use a Marina", costs).params.avatarName).toBe("Marina");
  });

  it("pedido vazio é recusado", () => {
    expect(() => parseChangeRequest("   ", costs)).toThrow(/Descreva/);
  });
});
