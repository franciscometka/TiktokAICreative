import { describe, expect, it } from "vitest";
import { QUALITY_PRESETS } from "@/config/quality-presets";
import { generatedVideoSeconds, type CreativePlan, type ScenePlan } from "@/domain/creative";
import { catalog, simplePlan } from "@/test/fixtures";
import { resolvePricing } from "./calculate";
import { evaluatePlanAgainstPreset, fitPlanToPreset, MIN_GENERATED_SECONDS_PER_SCENE, reviewCampaignPlan } from "./plan-evaluation";

const economy = QUALITY_PRESETS.economy; // 8–12s IA, 20–30s final
const pricing = resolvePricing(economy, catalog);

function genScene(id: string, order: number, duration: number, gen: number): ScenePlan {
  return {
    id,
    order,
    duration,
    narration: "fala",
    onScreenText: "texto",
    visualDescription: "visual",
    generationPrompt: "prompt",
    shotType: "close_up",
    visualSource: "generated_video",
    motion: "none",
    requiresGeneratedVideo: true,
    estimatedGenerationSeconds: gen,
  };
}

function imageScene(id: string, order: number, duration: number): ScenePlan {
  return {
    ...genScene(id, order, duration, 0),
    generationPrompt: "",
    visualSource: "product_image",
    motion: "ken_burns",
    requiresGeneratedVideo: false,
  };
}

/** 25s finais, 18s de IA: hook 5s, cena 6s, imagem, cena 7s. */
function overPlan(): CreativePlan {
  return simplePlan({
    duration: 25,
    scenes: [genScene("s1", 0, 5, 5), genScene("s2", 1, 6, 6), imageScene("s3", 2, 7), genScene("s4", 3, 7, 7)],
  });
}

describe("evaluatePlanAgainstPreset", () => {
  it("plano dentro do preset é válido e informa segundos e faixas", () => {
    const plan = simplePlan({ duration: 25, scenes: [genScene("s1", 0, 10, 10), imageScene("s2", 1, 15)] });
    const r = evaluatePlanAgainstPreset(plan, economy, pricing, 5);
    expect(r).toMatchObject({
      valid: true,
      generatedSeconds: 10,
      allowedGeneratedSeconds: { min: 8, max: 12 },
      finalSeconds: 25,
      errors: [],
      warnings: [],
    });
    expect(r.estimatedFutureCostBrl).toBeGreaterThan(0);
  });

  it("acima do máximo de segundos de IA é ERRO (inválido)", () => {
    const r = evaluatePlanAgainstPreset(overPlan(), economy, pricing, 5);
    expect(r.valid).toBe(false);
    expect(r.generatedSeconds).toBe(18);
    expect(r.errors.map((e) => e.code)).toEqual(["GENERATED_SECONDS_ABOVE_PRESET"]);
  });

  it("abaixo do mínimo e sem IA são apenas avisos (mais barato)", () => {
    const below = simplePlan({ duration: 25, scenes: [genScene("s1", 0, 4, 4), imageScene("s2", 1, 21)] });
    expect(evaluatePlanAgainstPreset(below, economy, pricing, 5).warnings.map((w) => w.code)).toEqual([
      "GENERATED_SECONDS_BELOW_PRESET",
    ]);
    const none = simplePlan({ duration: 25, scenes: [imageScene("s1", 0, 25)] });
    const r = evaluatePlanAgainstPreset(none, economy, pricing, 5);
    expect(r.valid).toBe(true);
    expect(r.warnings.map((w) => w.code)).toEqual(["NO_GENERATED_VIDEO"]);
  });

  it("duração final fora da faixa gera aviso", () => {
    const long = simplePlan({ duration: 40, scenes: [genScene("s1", 0, 10, 10), imageScene("s2", 1, 30)] });
    expect(evaluatePlanAgainstPreset(long, economy, pricing, 5).warnings.map((w) => w.code)).toContain(
      "FINAL_DURATION_OUT_OF_RANGE",
    );
  });
});

describe("fitPlanToPreset — ajuste determinístico", () => {
  it("não altera plano dentro do limite", () => {
    const plan = simplePlan();
    const r = fitPlanToPreset(plan, economy);
    expect(r.plan).toBe(plan);
    expect(r.adjustments).toEqual([]);
  });

  it("reduz/converte da última cena para a primeira, protegendo o gancho, até caber no máximo", () => {
    const { plan, adjustments } = fitPlanToPreset(overPlan(), economy);
    expect(generatedVideoSeconds(plan)).toBeLessThanOrEqual(12);
    // Excesso 6s: s4 (7s) pode cair para 1s? Não — mínimo de 2s por clipe → vira imagem (−7s).
    expect(adjustments).toEqual([
      expect.objectContaining({ sceneId: "s4", kind: "converted_to_product_image", fromSeconds: 7, toSeconds: 0 }),
    ]);
    const s4 = plan.scenes.find((s) => s.id === "s4")!;
    expect(s4).toMatchObject({ visualSource: "product_image", requiresGeneratedVideo: false, generationPrompt: "" });
    // Gancho intacto e duração total preservada.
    expect(plan.scenes[0]?.estimatedGenerationSeconds).toBe(5);
    expect(plan.duration).toBe(25);
  });

  it("prefere reduzir segundos quando a cena continua com o mínimo", () => {
    const plan = simplePlan({
      duration: 25,
      scenes: [genScene("s1", 0, 5, 5), imageScene("s2", 1, 12), genScene("s3", 2, 8, 8)],
    });
    const r = fitPlanToPreset(plan, economy); // 13s → excesso 1s
    expect(r.adjustments).toEqual([
      expect.objectContaining({ sceneId: "s3", kind: "reduced_generation_seconds", fromSeconds: 8, toSeconds: 7 }),
    ]);
    expect(generatedVideoSeconds(r.plan)).toBe(12);
    expect(MIN_GENERATED_SECONDS_PER_SCENE).toBe(2);
  });

  it("se só sobrar o gancho, reduz o gancho ao máximo", () => {
    const plan = simplePlan({ duration: 25, scenes: [genScene("s1", 0, 20, 20), imageScene("s2", 1, 5)] });
    const r = fitPlanToPreset(plan, economy);
    expect(generatedVideoSeconds(r.plan)).toBe(12);
    expect(r.adjustments[0]).toMatchObject({ sceneId: "s1", kind: "reduced_generation_seconds", toSeconds: 12 });
  });
});

describe("reviewCampaignPlan", () => {
  it("nunca devolve criativo acima do máximo e marca hooks repetidos", () => {
    const a = overPlan();
    const b = { ...simplePlan({ id: "creative_2" }), hook: a.hook };
    const campaign = {
      product: { id: "p", name: "n", description: "d", features: [], benefits: [], images: [] },
      analysis: {
        summary: "s",
        targetAudiences: ["a"],
        problemsSolved: ["p"],
        benefits: ["b"],
        differentiators: [],
        sellingAngles: ["x"],
        objections: [],
        communicationRisks: [],
        missingInformation: [],
      },
      hooks: [{ id: "h1", text: "h", angle: "a", style: "ugc" as const }],
      concepts: [a.concept, b.concept],
      creatives: [a, b],
    };
    const r = reviewCampaignPlan(campaign, economy, pricing, 5);
    expect(r.reviews[0]?.original.valid).toBe(false);
    expect(r.reviews[0]?.final.valid).toBe(true);
    expect(r.reviews[0]?.adjustments).toHaveLength(1);
    expect(r.plan.creatives.every((c) => generatedVideoSeconds(c) <= 12)).toBe(true);
    expect(r.reviews.flatMap((rv) => rv.final.warnings.map((w) => w.code))).toContain("DUPLICATE_HOOKS");
  });
});
