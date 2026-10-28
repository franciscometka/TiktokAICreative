import { describe, expect, it } from "vitest";
import { VISUAL_SOURCES, requiresGeneratedVideoForVisualSource } from "@/domain/creative";
import { normalizeCampaignPlanDerivedFields } from "./normalize-campaign-plan";

const normalizeScene = (scene: Record<string, unknown>) => {
  const normalized = normalizeCampaignPlanDerivedFields({ creatives: [{ scenes: [scene] }] }) as {
    creatives: { scenes: Record<string, unknown>[] }[];
  };
  return normalized.creatives[0]!.scenes[0]!;
};

describe("campos derivados do plano do Claude", () => {
  it("classifica todos os visualSource conhecidos por uma única função canônica", () => {
    expect(VISUAL_SOURCES).toHaveLength(17);
    expect(VISUAL_SOURCES.filter(requiresGeneratedVideoForVisualSource)).toEqual([
      "generated_video", "product_hero", "product_demo", "lifestyle", "presenter", "product_ugc",
      "ugc_hook", "ugc_demo", "ugc_benefit", "ugc_cta", "product_broll",
    ]);
  });

  it("fonte gerada com false (ou sem o campo) é derivada como true", () => {
    expect(normalizeScene({ visualSource: "generated_video", requiresGeneratedVideo: false }).requiresGeneratedVideo).toBe(true);
    expect(normalizeScene({ visualSource: "ugc_demo" }).requiresGeneratedVideo).toBe(true);
  });

  it("asset existente/referência com true é derivado como false", () => {
    expect(normalizeScene({ visualSource: "existing_asset", requiresGeneratedVideo: true }).requiresGeneratedVideo).toBe(false);
    expect(normalizeScene({ visualSource: "reference_detail", requiresGeneratedVideo: true }).requiresGeneratedVideo).toBe(false);
  });

  it("fonte desconhecida e campos criativos não são consertados", () => {
    const scene = { visualSource: "unknown_future", requiresGeneratedVideo: true, visualDescription: "" };
    expect(normalizeScene(scene)).toEqual(scene);
  });
});
