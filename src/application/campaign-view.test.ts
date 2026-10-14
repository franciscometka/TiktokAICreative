import { describe, expect, it } from "vitest";
import { QUALITY_PRESETS } from "@/config/quality-presets";
import { fitPlanToPreset } from "@/costs/plan-evaluation";
import type { Campaign } from "@/domain/pipeline";
import type { CreativeReview, PlanEvaluation } from "@/domain/plan-evaluation";
import { campaignRequest, simplePlan } from "@/test/fixtures";
import { campaignState, imagePreviewUrl, presetAdjustment } from "./campaign-view";

const economy = QUALITY_PRESETS.economy;

function evaluation(generatedSeconds: number): PlanEvaluation {
  return {
    creativeId: "creative_1",
    valid: generatedSeconds <= economy.generatedVideoSeconds.max,
    generatedSeconds,
    allowedGeneratedSeconds: economy.generatedVideoSeconds,
    finalSeconds: 20,
    allowedFinalSeconds: economy.finalVideoSeconds,
    errors: [],
    warnings: [],
    estimatedFutureCostBrl: 1,
  };
}

describe("ajuste automático ao preset (fitPlanToPreset) na interface", () => {
  it("vira 'Plano otimizado' com sugerido × ajustado, não erro", () => {
    // 16s de IA no Econômico (máx. 12s) → o sistema ajusta.
    const over = simplePlan({
      duration: 20,
      scenes: [
        { ...simplePlan().scenes[0]!, duration: 8, estimatedGenerationSeconds: 8 },
        {
          ...simplePlan().scenes[0]!,
          id: "scene_2",
          order: 1,
          duration: 12,
          estimatedGenerationSeconds: 8,
        },
      ],
    });
    const { plan, adjustments } = fitPlanToPreset(over, economy);
    const review: CreativeReview = { creativeId: plan.id, original: evaluation(16), adjustments, final: evaluation(12) };

    expect(presetAdjustment(review, economy.label, "anthropic")).toEqual({
      qualityLabel: "Econômico",
      suggestedBy: "Claude",
      suggestedSeconds: 16,
      adjustedSeconds: 12,
      messages: adjustments.map((a) => a.message),
    });
    expect(presetAdjustment(review, economy.label, "mock")?.suggestedBy).toBe("Planejamento simulado");
  });

  it("sem ajuste, nada é mostrado", () => {
    const review: CreativeReview = { creativeId: "c", original: evaluation(10), adjustments: [], final: evaluation(10) };
    expect(presetAdjustment(review, "Econômico", "anthropic")).toBeUndefined();
    expect(presetAdjustment(undefined, "Econômico", "anthropic")).toBeUndefined();
  });
});

describe("estado da campanha para a interface", () => {
  const base: Campaign = {
    id: "campaign_1",
    status: "planning",
    request: campaignRequest(),
    settings: economy,
    jobIds: [],
    createdAt: "2026-10-14T00:00:00.000Z",
    updatedAt: "2026-10-14T00:00:00.000Z",
  };

  it("planning com execução neste processo = planejando; sem execução = interrompida", () => {
    expect(campaignState(base, true)).toBe("planning");
    expect(campaignState(base, false)).toBe("interrupted");
    expect(campaignState({ ...base, status: "draft" }, false)).toBe("interrupted");
  });

  it("planned e failed não dependem do processo", () => {
    expect(campaignState({ ...base, status: "planned" }, false)).toBe("planned");
    expect(campaignState({ ...base, status: "failed" }, true)).toBe("failed");
  });
});

describe("imagePreviewUrl", () => {
  it("só gera URL para nomes criados pelo upload", () => {
    const id = "img_00000000-0000-0000-0000-000000000000.jpg";
    expect(imagePreviewUrl("prod_1", id)).toBe(`/api/uploads/prod_1/${id}`);
    expect(imagePreviewUrl("prod_1", "img_1")).toBeUndefined();
    expect(imagePreviewUrl("prod_1", "../secret.jpg")).toBeUndefined();
  });
});
