import { describe, expect, it } from "vitest";
import { product, simplePlan } from "@/test/fixtures";
import { CampaignPlanDraftSchema } from "./campaign";
import { CostBudgetSchema, ProviderPricingSchema } from "./cost";
import {
  CreativePlanSchema,
  generatedVideoSeconds,
  narrationCharacters,
  ScenePlanDraftSchema,
} from "./creative";
import { ProductInputSchema } from "./product";
import { QualitySettingsSchema } from "./quality";
import { QUALITY_PRESETS } from "@/config/quality-presets";

const scene = {
  duration: 5,
  narration: "fala",
  onScreenText: "texto",
  visualDescription: "visual",
  generationPrompt: "prompt",
  shotType: "close_up" as const,
  visualSource: "generated_video" as const,
  motion: "none" as const,
  requiresGeneratedVideo: true,
  estimatedGenerationSeconds: 5,
};

describe("ProductInputSchema", () => {
  it("aceita produto válido", () => {
    expect(ProductInputSchema.safeParse(product()).success).toBe(true);
  });

  it("rejeita nome vazio, URL inválida e preço negativo", () => {
    expect(ProductInputSchema.safeParse(product({ name: "  " })).success).toBe(false);
    expect(ProductInputSchema.safeParse(product({ url: "não-é-url" })).success).toBe(false);
    expect(ProductInputSchema.safeParse(product({ priceBrl: -1 })).success).toBe(false);
  });
});

describe("ScenePlanDraftSchema — regras de vídeo gerado", () => {
  it("aceita cena com vídeo IA coerente", () => {
    expect(ScenePlanDraftSchema.safeParse(scene).success).toBe(true);
  });

  it("exige segundos > 0 e prompt quando requiresGeneratedVideo", () => {
    expect(ScenePlanDraftSchema.safeParse({ ...scene, estimatedGenerationSeconds: 0 }).success).toBe(false);
    expect(ScenePlanDraftSchema.safeParse({ ...scene, generationPrompt: " " }).success).toBe(false);
  });

  it("não permite gerar mais segundos que a duração da cena", () => {
    expect(ScenePlanDraftSchema.safeParse({ ...scene, estimatedGenerationSeconds: 6 }).success).toBe(false);
  });

  it("cena sem vídeo IA deve ter 0 segundos gerados", () => {
    const r = ScenePlanDraftSchema.safeParse({
      ...scene,
      visualSource: "product_image",
      requiresGeneratedVideo: false,
      estimatedGenerationSeconds: 2,
    });
    expect(r.success).toBe(false);
  });

  it("requiresGeneratedVideo deve concordar com visualSource (estratégia híbrida)", () => {
    expect(ScenePlanDraftSchema.safeParse({ ...scene, visualSource: "product_image" }).success).toBe(false);
    const image = { ...scene, visualSource: "text_card", motion: "zoom_in", requiresGeneratedVideo: false, estimatedGenerationSeconds: 0, generationPrompt: "" };
    expect(ScenePlanDraftSchema.safeParse(image).success).toBe(true);
    expect(ScenePlanDraftSchema.safeParse({ ...image, motion: "spin" }).success).toBe(false);
  });

  it("rejeita shotType desconhecido", () => {
    expect(ScenePlanDraftSchema.safeParse({ ...scene, shotType: "drone" }).success).toBe(false);
  });
});

describe("CreativePlanSchema", () => {
  it("aceita plano válido e calcula segundos gerados vs finais", () => {
    const plan = CreativePlanSchema.parse(simplePlan());
    expect(generatedVideoSeconds(plan)).toBe(8);
    expect(plan.duration).toBe(20);
    expect(narrationCharacters(plan)).toBe(300);
  });

  it("rejeita soma de cenas diferente da duração", () => {
    expect(CreativePlanSchema.safeParse(simplePlan({ duration: 30 })).success).toBe(false);
  });

  it("aceita diferença dentro da tolerância", () => {
    expect(CreativePlanSchema.safeParse(simplePlan({ duration: 20.4 })).success).toBe(true);
  });

  it("rejeita ordem de cenas fora de sequência", () => {
    const plan = simplePlan();
    const scenes = plan.scenes.map((s, i) => ({ ...s, order: i === 1 ? 5 : s.order }));
    expect(CreativePlanSchema.safeParse({ ...plan, scenes }).success).toBe(false);
  });
});

describe("CampaignPlanDraftSchema (saída do LLM)", () => {
  it("exige estrutura mínima: análise, ao menos 1 hook e 1 criativo", () => {
    expect(CampaignPlanDraftSchema.safeParse({ analysis: {}, hooks: [], creatives: [] }).success).toBe(false);
  });
});

describe("schemas de custo e qualidade", () => {
  it("presets são QualitySettings válidos", () => {
    for (const preset of Object.values(QUALITY_PRESETS)) {
      expect(QualitySettingsSchema.safeParse(preset).success).toBe(true);
    }
  });

  it("ProviderPricing exige data ISO e preço não negativo", () => {
    const base = { provider: "p", model: "m", unit: "per_second", priceUsd: 1, updatedAt: "2026-10-13", isPlaceholder: false };
    expect(ProviderPricingSchema.safeParse(base).success).toBe(true);
    expect(ProviderPricingSchema.safeParse({ ...base, updatedAt: "ontem" }).success).toBe(false);
    expect(ProviderPricingSchema.safeParse({ ...base, priceUsd: -0.01 }).success).toBe(false);
    expect(ProviderPricingSchema.safeParse({ ...base, unit: "per_minute" }).success).toBe(false);
  });

  it("CostBudget exige limites positivos", () => {
    expect(CostBudgetSchema.safeParse({ maxCostPerCreativeBrl: 0, maxCostPerCampaignBrl: 10, allowOverBudget: false }).success).toBe(false);
  });
});
