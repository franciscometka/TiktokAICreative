import { describe, expect, it } from "vitest";
import { RenderManifestSchema } from "@/domain/render";
import { product, simplePlan } from "@/test/fixtures";
import { buildRenderManifest, MissingAssetError } from "./manifest";

const base = {
  campaignId: "campaign_1",
  plan: simplePlan(),
  product: product(),
  sceneVideos: new Map([["scene_1", "mock://video/1.mp4"]]),
  narration: { uri: "mock://audio/1.mp3", durationSeconds: 19 },
  outputDir: "outputs",
};

const NARRATION = [
  "Você já levou água gelada pra faculdade e às dez já estava morna?",
  "Essa garrafa tem parede dupla a vácuo e tampa com vedação. Toca no carrinho e garante a sua.",
];

describe("buildRenderManifest", () => {
  const plan = simplePlan();
  const manifest = buildRenderManifest({
    ...base,
    plan: { ...plan, scenes: plan.scenes.map((s, i) => ({ ...s, narration: NARRATION[i] ?? "" })) },
  });

  it("vídeo final vertical 1080x1920 mais longo que o trecho gerado por IA", () => {
    expect(manifest.output).toEqual({
      width: 1080,
      height: 1920,
      fps: 30,
      container: "mp4",
      path: "outputs/renders/campaign_1/creative_1",
    });
    expect(manifest.campaignId).toBe("campaign_1");
    expect(manifest.duration).toBe(20);
    expect(manifest.generatedVideoSeconds).toBe(8);
  });

  it("cena com IA usa o vídeo gerado; cena sem IA usa imagem do produto com movimento; tipo visual preservado", () => {
    expect(manifest.assets).toMatchObject([
      { sceneId: "scene_1", kind: "generated_video", uri: "mock://video/1.mp4", startSeconds: 0, motion: "none", visualSource: "generated_video" },
      { sceneId: "scene_2", kind: "product_image", uri: "outputs/uploads/img_1.jpg", startSeconds: 8, motion: "ken_burns", visualSource: "product_image" },
    ]);
    expect(manifest.assets[0]?.visualDescription).toBe("close");
  });

  it("legendas: narração segmentada em trechos curtos dentro da duração de cada cena", () => {
    expect(manifest.captions.length).toBeGreaterThan(2);
    for (const c of manifest.captions) {
      expect(c.endSeconds).toBeGreaterThan(c.startSeconds);
      expect(c.text.length).toBeLessThanOrEqual(30);
    }
    const scene1 = manifest.captions.filter((c) => c.endSeconds <= 8);
    expect(scene1[0]?.startSeconds).toBe(0);
    expect(scene1[scene1.length - 1]?.endSeconds).toBe(8);
    expect(manifest.captions[manifest.captions.length - 1]?.endSeconds).toBe(20);
  });

  it("overlays carregam nome, preço, CTA, hook e benefício", () => {
    expect(manifest.overlays).toEqual({
      productName: "Garrafa Térmica X",
      priceBrl: 89.9,
      callToAction: "Compre agora",
      hook: "Olha isso",
      benefit: "Bebida gelada o dia todo",
    });
    expect(manifest.audio).toHaveLength(1);
  });

  it("sem imagens do produto, cena product_image vira texto e registra warning", () => {
    const m = buildRenderManifest({ ...base, product: product({ images: [] }) });
    expect(m.assets[1]).toMatchObject({ kind: "text_card", uri: null });
    expect(m.warnings).toEqual([expect.objectContaining({ code: "product_image_missing", sceneId: "scene_2" })]);
  });

  it("screenshot/existing_asset sem asset: fallback explícito com warning", () => {
    const plan = simplePlan();
    const scenes = plan.scenes.map((s, i) => (i === 1 ? { ...s, visualSource: "screenshot" as const } : s));
    const m = buildRenderManifest({ ...base, plan: { ...plan, scenes } });
    expect(m.assets[1]).toMatchObject({ kind: "product_image", visualSource: "screenshot" });
    expect(m.warnings[0]).toMatchObject({ code: "asset_not_provided", sceneId: "scene_2" });
  });

  it("falha se uma cena com IA não tiver asset ativo", () => {
    expect(() => buildRenderManifest({ ...base, sceneVideos: new Map() })).toThrow(MissingAssetError);
  });

  it("manifest do Lote 2 (sem campos novos) continua válido", () => {
    const legacy = {
      creativeId: "c1",
      assets: [{ sceneId: "s1", kind: "text_card", uri: null, startSeconds: 0, durationSeconds: 5, motion: "none", shotType: "text_card", onScreenText: "x" }],
      audio: [],
      captions: [],
      overlays: { productName: "P", callToAction: "CTA" },
      duration: 5,
      generatedVideoSeconds: 0,
      output: { width: 1080, height: 1920, fps: 30, container: "mp4", path: "outputs/campaign_1/c1.mp4" },
    };
    expect(RenderManifestSchema.parse(legacy).warnings).toEqual([]);
  });
});
