import { describe, expect, it } from "vitest";
import { summarizePresets } from "@/costs/preset-summary";
import type { BudgetExceededDecision, CostEstimate } from "@/domain/cost";
import { summarizeActualCosts } from "@/costs/ledger";
import { catalog, RATE } from "@/test/fixtures";
import {
  formatBrlRange,
  formatSecondsRange,
  presentActualCosts,
  presentBudgetDecision,
  presentEstimate,
} from "./cost-presentation";

const line = (category: "video" | "audio" | "rendering", subtotalUsd: number, isPlaceholderPrice: boolean) => ({
  category,
  phase: category === "rendering" ? ("rendering" as const) : ("generation" as const),
  description: category,
  provider: "p",
  model: "m",
  unit: "per_second" as const,
  quantity: 1,
  unitPriceUsd: subtotalUsd,
  subtotalUsd,
  isPlaceholderPrice,
});

const ESTIMATE: CostEstimate = {
  kind: "estimate",
  id: "estimate_1",
  creativeId: "creative_1",
  quality: "economy",
  incurred: { llmCost: { usd: 0.08, brl: 0.42 }, ledgerEntryIds: ["cost_1"], sharedAmongCreatives: 2, simulated: false },
  videoCost: { usd: 0.8, brl: 4 },
  audioCost: { usd: 0.01, brl: 0.06 },
  renderingCost: { usd: 0, brl: 0 },
  estimatedAdditionalUsd: 0.81,
  estimatedAdditionalBrl: 4.06,
  projectedTotalUsd: 0.89,
  projectedTotalBrl: 4.48,
  exchangeRate: 5,
  generatedVideoSeconds: 10,
  finalVideoSeconds: 25,
  breakdown: [line("video", 0.8, true), line("audio", 0.01, true), line("rendering", 0, false)],
  containsPlaceholderPrices: true,
  createdAt: "2026-10-14T00:00:00.000Z",
};

describe("presentEstimate", () => {
  it("separa JÁ UTILIZADO (real) do FUTURO ESTIMADO, sem somar os dois fora do total", () => {
    const p = presentEstimate(ESTIMATE);
    expect(p.incurred).toEqual({ label: "Planejamento Claude", brl: 0.42, simulated: false, sharedAmongCreatives: 2 });
    expect(p.future.map((f) => [f.label, f.brl])).toEqual([
      ["Vídeo", 4],
      ["Áudio", 0.06],
      ["Renderização", 0],
    ]);
    // O botão "Gerar por ~R$X" usa o futuro; o projetado vem pronto do domínio.
    expect(p.futureTotalBrl).toBe(4.06);
    expect(p.projectedTotalBrl).toBe(4.48);
    expect(p.estimateId).toBe("estimate_1");
    expect([p.finalVideoSeconds, p.generatedVideoSeconds]).toEqual([25, 10]);
  });

  it("marca 'estimativa provisória' por categoria quando o preço é placeholder", () => {
    const p = presentEstimate(ESTIMATE);
    expect(p.future.find((f) => f.category === "video")?.isPlaceholder).toBe(true);
    expect(p.future.find((f) => f.category === "rendering")?.isPlaceholder).toBe(false);
    expect(p.containsPlaceholderPrices).toBe(true);
  });

  it("incorrido simulado (mock) é sinalizado", () => {
    const p = presentEstimate({ ...ESTIMATE, incurred: { ...ESTIMATE.incurred, simulated: true } });
    expect(p.incurred.simulated).toBe(true);
  });
});

describe("presentBudgetDecision", () => {
  const decision: BudgetExceededDecision = {
    kind: "BUDGET_EXCEEDED",
    scope: "creative",
    currentCostBrl: 8,
    additionalEstimatedCostBrl: 9,
    newEstimatedTotalBrl: 17,
    budgetBrl: 15,
    canAuthorizeOverBudget: true,
  };

  it("mapeia limite, atual, próxima geração, projetado e excedente", () => {
    expect(presentBudgetDecision(decision)).toEqual({
      scope: "creative",
      scopeLabel: "Limite por criativo",
      limitBrl: 15,
      currentBrl: 8,
      nextBrl: 9,
      projectedBrl: 17,
      excessBrl: 2,
      canAuthorize: true,
      authorizeUpToBrl: 17,
    });
  });

  it("a permissão de autorizar vem do domínio", () => {
    const p = presentBudgetDecision({ ...decision, scope: "campaign", canAuthorizeOverBudget: false });
    expect(p.canAuthorize).toBe(false);
    expect(p.scopeLabel).toBe("Limite da campanha");
  });
});

describe("presentActualCosts", () => {
  it("separa planejamento de mídia e marca simulação", () => {
    const summary = summarizeActualCosts([], new Set());
    expect(presentActualCosts(summary)).toEqual({ totalBrl: 0, planningBrl: 0, mediaBrl: 0, discardedBrl: 0, simulated: false });
  });
});

describe("cards de qualidade", () => {
  it("todos os números vêm do sistema de custos (sem valores fixos na UI)", () => {
    const presets = summarizePresets(catalog, RATE);
    expect(presets.map((p) => p.quality)).toEqual(["economy", "high", "premium"]);
    for (const p of presets) {
      expect(p.estimatedCostBrl.min).toBeGreaterThan(0);
      expect(p.estimatedCostBrl.max).toBeGreaterThanOrEqual(p.estimatedCostBrl.min);
      expect(p.llmModelName).toMatch(/^Claude /);
      expect(p.containsPlaceholderPrices).toBe(true);
    }
    expect(presets[2]?.llmModelName).toBe("Claude Opus 5.5");
  });

  it("formata faixas de dinheiro e segundos", () => {
    expect(formatBrlRange({ min: 4.12, max: 5.96 })).toBe("R$ 4,12 – R$ 5,96");
    expect(formatSecondsRange({ min: 8, max: 12 })).toBe("8–12s");
    expect(formatSecondsRange({ min: 10, max: 10 })).toBe("10s");
  });
});
