import { describe, expect, it } from "vitest";
import { DEFAULT_EXCHANGE_RATE } from "@/config/pricing";
import { QUALITY_PRESETS } from "@/config/quality-presets";
import { CostEstimateSchema, GenerationCostSchema } from "@/domain/cost";
import { usdToBrl } from "@/lib/money";
import { catalog, pricing, simplePlan } from "@/test/fixtures";
import {
  buildActualCost,
  costForUsage,
  estimateCreativeCost,
  estimatePresetRange,
  llmCallCostLines,
  llmCallCostUsd,
  priceUnits,
  quantityFor,
  resolveLlmPricing,
  resolvePricing,
  UnsupportedUsageError,
  worstCaseLlmCostUsd,
} from "./calculate";
import { CLAUDE_MODELS } from "@/config/llm-models";
import { summarizePresets } from "./preset-summary";

describe("conversão USD → BRL", () => {
  it("multiplica pela cotação", () => {
    expect(usdToBrl(2, 5.5)).toBe(11);
  });

  it("rejeita cotação inválida", () => {
    expect(() => usdToBrl(1, 0)).toThrow(RangeError);
    expect(() => usdToBrl(1, Number.NaN)).toThrow(RangeError);
  });
});

describe("priceUnits / quantityFor", () => {
  it.each([
    ["per_second", 10, 0.1, 1],
    ["per_1000_characters", 1500, 0.2, 0.3],
    ["per_1m_input_tokens", 500_000, 4, 2],
    ["per_1m_output_tokens", 2_000_000, 20, 40],
    ["per_generation", 3, 0.5, 1.5],
  ] as const)("%s: %d unidades a US$%d → US$%d", (unit, qty, price, expected) => {
    expect(priceUnits(pricing({ unit, priceUsd: price }), qty)).toBeCloseTo(expected, 10);
  });

  it("lê o campo de consumo correspondente à unidade", () => {
    expect(quantityFor("per_second", { seconds: 7 })).toBe(7);
    expect(quantityFor("per_1000_characters", { characters: 120 })).toBe(120);
    expect(quantityFor("per_generation", {})).toBe(1);
  });

  it("falha explicitamente quando o consumo necessário não foi informado", () => {
    expect(() => quantityFor("per_second", { characters: 10 })).toThrow(UnsupportedUsageError);
    expect(() => quantityFor("per_second", { seconds: -1 })).toThrow(UnsupportedUsageError);
  });

  it("rejeita quantidade negativa", () => {
    expect(() => priceUnits(pricing(), -1)).toThrow(RangeError);
  });
});

describe("custo REAL do Claude a partir do usage", () => {
  const sonnet = resolveLlmPricing({ provider: "anthropic", model: CLAUDE_MODELS.sonnet }, catalog);
  const opus = resolveLlmPricing({ provider: "anthropic", model: CLAUDE_MODELS.opus }, catalog);
  const usage = { inputTokens: 3_000, outputTokens: 12_000, cacheCreationInputTokens: 2_000, cacheReadInputTokens: 4_000 };

  it("Sonnet 5.5: entrada US$2, saída US$10, escrita de cache 1,25× entrada, leitura US$0.20 por 1M", () => {
    const lines = llmCallCostLines(sonnet, usage);
    expect(lines.map((l) => [l.label, l.quantity])).toEqual([
      ["entrada", 3_000],
      ["saída", 12_000],
      ["escrita de cache", 2_000],
      ["leitura de cache", 4_000],
    ]);
    // 0.006 + 0.12 + 0.005 + 0.0008
    expect(llmCallCostUsd(sonnet, usage)).toBeCloseTo(0.1318, 10);
  });

  it("Opus 5.5 custa o dobro do Sonnet por token neste caso", () => {
    // 0.012 + 0.24 + 0.01 + 0.0008
    expect(llmCallCostUsd(opus, usage)).toBeCloseTo(0.2628, 10);
  });

  it("omite linhas de cache zeradas, mas sempre mostra entrada e saída", () => {
    const lines = llmCallCostLines(sonnet, { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 });
    expect(lines.map((l) => l.label)).toEqual(["entrada", "saída"]);
  });

  it("pior caso = tentativas × (entrada estimada + máximo de saída)", () => {
    const wc = worstCaseLlmCostUsd(sonnet, { estimatedInputTokens: 10_000, maxOutputTokens: 20_000, maxAttempts: 2 });
    expect(wc).toBeCloseTo(2 * (0.02 + 0.2), 10);
  });
});

describe("estimateCreativeCost — incorrido × futuro", () => {
  const settings = QUALITY_PRESETS.economy;
  const resolved = resolvePricing(settings, catalog);
  const incurred = {
    llmCost: { usd: 0.042, brl: 0.21 },
    ledgerEntryIds: ["cost_1", "cost_2"],
    sharedAmongCreatives: 1,
    simulated: false,
  };
  const estimate = estimateCreativeCost({
    id: "est_1",
    plan: simplePlan(),
    settings,
    pricing: resolved,
    incurred,
    exchangeRate: 5,
    createdAt: "2026-10-13T00:00:00.000Z",
  });

  it("é uma ESTIMATIVA válida e marcada como tal", () => {
    expect(CostEstimateSchema.safeParse(estimate).success).toBe(true);
    expect(estimate.kind).toBe("estimate");
  });

  it("custo já incorrido vem do ledger, não é estimado", () => {
    expect(estimate.incurred).toEqual(incurred);
    expect(estimate.breakdown.some((l) => l.category === "llm")).toBe(false);
  });

  it("custo futuro: vídeo por cena com IA + áudio + render", () => {
    expect(estimate.videoCost.usd).toBeCloseTo(0.64, 6); // 8s × US$0.08
    expect(estimate.videoCost.brl).toBeCloseTo(3.2, 2);
    expect(estimate.audioCost.usd).toBeCloseTo(0.015, 6); // 300 caracteres × US$0.05/1000
    expect(estimate.renderingCost.usd).toBe(0);
    expect(estimate.estimatedAdditionalUsd).toBeCloseTo(0.655, 6);
  });

  it("total projetado = incorrido + futuro", () => {
    expect(estimate.projectedTotalUsd).toBeCloseTo(0.697, 6);
    expect(estimate.projectedTotalBrl).toBeCloseTo(0.21 + estimate.estimatedAdditionalBrl, 2);
  });

  it("separa segundos gerados por IA da duração final e guarda a cotação", () => {
    expect(estimate.generatedVideoSeconds).toBe(8);
    expect(estimate.finalVideoSeconds).toBe(20);
    expect(estimate.exchangeRate).toBe(5);
    expect(estimate.containsPlaceholderPrices).toBe(true);
  });

  it("detalha uma linha por cena com IA, referenciando a cena", () => {
    const videoLines = estimate.breakdown.filter((l) => l.category === "video");
    expect(videoLines).toHaveLength(1);
    expect(videoLines[0]?.sceneId).toBe("scene_1");
  });
});

describe("buildActualCost — custo efetivo", () => {
  it("gera registro 'actual' a partir do consumo faturado", () => {
    const cost = buildActualCost({
      id: "cost_1",
      campaignId: "c1",
      jobId: "j1",
      creativeId: "cr1",
      sceneId: "s1",
      attemptId: "a1",
      operation: "video_generation",
      category: "video",
      description: "teste",
      pricing: pricing({ priceUsd: 0.1 }),
      usage: { seconds: 12 },
      exchangeRate: 5,
      simulated: true,
      createdAt: "2026-10-13T00:00:00.000Z",
    });
    expect(GenerationCostSchema.safeParse(cost).success).toBe(true);
    expect(cost.kind).toBe("actual");
    expect(cost.costUsd).toBeCloseTo(1.2, 6);
    expect(cost.costBrl).toBe(6);
    expect(costForUsage(pricing({ priceUsd: 0.1 }), { seconds: 12 }).quantity).toBe(12);
  });
});

describe("presets — faixas de custo com a configuração atual", () => {
  const summaries = summarizePresets(catalog, DEFAULT_EXCHANGE_RATE);

  it.each(summaries.map((s) => [s.quality, s] as const))(
    "%s: faixa calculada fica dentro da meta inicial",
    (_quality, summary) => {
      // Teste de SANIDADE da configuração: se preços/cotação mudarem e a faixa sair
      // da meta, este teste falha para forçar revisão consciente dos presets.
      const target = summary.targetCostBrl;
      expect(target).toBeDefined();
      if (!target) return;
      expect(summary.estimatedCostBrl.min).toBeGreaterThanOrEqual(target.min);
      expect(summary.estimatedCostBrl.max).toBeLessThanOrEqual(target.max);
    },
  );

  it("faixa mínima < máxima e economy < high < premium", () => {
    const [economy, high, premium] = summaries;
    expect(economy && high && premium).toBeTruthy();
    expect(economy!.estimatedCostBrl.max).toBeLessThan(high!.estimatedCostBrl.max);
    expect(high!.estimatedCostBrl.max).toBeLessThan(premium!.estimatedCostBrl.max);
    for (const s of summaries) expect(s.estimatedCostBrl.min).toBeLessThan(s.estimatedCostBrl.max);
  });

  it("estimatePresetRange reflete mudança de cotação", () => {
    const settings = QUALITY_PRESETS.high;
    const resolved = resolvePricing(settings, catalog);
    const at5 = estimatePresetRange(settings, resolved, 5);
    const at6 = estimatePresetRange(settings, resolved, 6);
    expect(at6.max.usd).toBe(at5.max.usd);
    expect(at6.max.brl).toBeGreaterThan(at5.max.brl);
  });
});
