import { describe, expect, it } from "vitest";
import { buildMotionPrompt, scenePromptFor } from "@/ai/video-prompt";
import { pickOutputRatio } from "@/domain/aspect";
import { ScenePlanDraftSchema } from "@/domain/creative";
import { sceneStrategy } from "@/render/scene-strategy";
import { runwayFixture } from "@/test/runway-fake";
import { simplePlan } from "@/test/fixtures";
import { ACTIVE_PROMPTS } from "@/ai/prompts/registry";
const ratios = ["720:1280", "1280:720", "960:960", "1104:832", "832:1104"];
describe("qualidade visual portada sem substituir Lote 5", () => {
  it.each([[1, "960:960"], [9/16, "720:1280"], [4/3, "1104:832"], [16/9, "1280:720"]])("preserva proporção %s", (aspect, ratio) => {
    expect(pickOutputRatio(ratios, Number(aspect), "full_product").ratio).toBe(ratio);
  });
  it.each(["product_hero", "product_demo", "lifestyle", "presenter", "product_ugc"] as const)("usa o schema e render existentes para %s", source => {
    expect(ScenePlanDraftSchema.safeParse({ ...simplePlan().scenes[0], visualSource: source }).success).toBe(true);
    expect(sceneStrategy(source, true).kind).toBe("generated_video");
  });
  it("aplica câmera por estratégia e ignora aproximação herdada", () => {
    expect(buildMotionPrompt("product_hero", undefined)).toContain("slides slowly sideways");
    expect(buildMotionPrompt("product_demo", undefined)).toContain("camera remains still");
    expect(buildMotionPrompt("product_demo", undefined)).toContain("uses it naturally");
    expect(buildMotionPrompt("lifestyle", undefined)).toContain("Handheld smartphone");
    expect(scenePromptFor({ ...simplePlan().scenes[0]!, generationPrompt: "slow push-in" }, "generated_video")).not.toMatch(/push|dollies in/i);
  });
  it("direção explícita controla ação sem redescrever a foto", () => {
    const prompt = buildMotionPrompt("product_demo", { framing: "in_context", camera: "locked", subjectAction: "a hand opens the lid", ambientMotion: "", pacing: "steady" });
    expect(prompt).toContain("A hand opens the lid.");
    expect(prompt).toContain("exact shape");
  });
  it("usa só a primeira referência e não chama receitas Product Ad", async () => {
    const f = await runwayFixture();
    await f.provider.generateScene({ ...f.request, referenceImageUris: [...f.request.referenceImageUris, "missing.png"] });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toContain("/image_to_video");
    expect(JSON.parse(String(f.calls[0]!.init?.body)).ratio).toBe("960:960");
  });
  it.each(["presenter", "product_ugc"] as const)("rejeita %s antes de pagar", async visualSource => {
    const f = await runwayFixture();
    await expect(f.provider.generateScene({ ...f.request, visualSource })).rejects.toThrow(/não suportado/);
    expect(f.calls).toHaveLength(0);
  });
  it("prompt ativo mantém honestidade e pede direção sem zoom padrão", () => {
    expect(ACTIVE_PROMPTS.campaignPlan.version).toBe("1.6.0");
    expect(ACTIVE_PROMPTS.campaignPlan.system).toContain("Não use slow push-in");
    expect(ACTIVE_PROMPTS.campaignPlan.system).toContain("Sem experiência inventada");
  });
});
