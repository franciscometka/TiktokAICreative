import { describe, expect, it } from "vitest";
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

describe("buildRenderManifest", () => {
  const manifest = buildRenderManifest(base);

  it("vídeo final vertical 1080x1920 mais longo que o trecho gerado por IA", () => {
    expect(manifest.output).toEqual({
      width: 1080,
      height: 1920,
      fps: 30,
      container: "mp4",
      path: "outputs/campaign_1/creative_1.mp4",
    });
    expect(manifest.duration).toBe(20);
    expect(manifest.generatedVideoSeconds).toBe(8);
  });

  it("cena com IA usa o vídeo gerado; cena sem IA usa imagem do produto com movimento", () => {
    expect(manifest.assets).toMatchObject([
      { sceneId: "scene_1", kind: "generated_video", uri: "mock://video/1.mp4", startSeconds: 0, motion: "none" },
      { sceneId: "scene_2", kind: "product_image", uri: "outputs/uploads/img_1.jpg", startSeconds: 8, motion: "ken_burns" },
    ]);
  });

  it("legendas seguem a linha do tempo e overlays carregam nome, preço e CTA", () => {
    expect(manifest.captions.map((c) => [c.startSeconds, c.endSeconds])).toEqual([
      [0, 8],
      [8, 20],
    ]);
    expect(manifest.overlays).toEqual({ productName: "Garrafa Térmica X", priceBrl: 89.9, callToAction: "Compre agora" });
    expect(manifest.audio).toHaveLength(1);
  });

  it("sem imagens do produto, cenas sem IA viram card de texto", () => {
    const m = buildRenderManifest({ ...base, product: product({ images: [] }) });
    expect(m.assets[1]).toMatchObject({ kind: "text_card", uri: null });
  });

  it("falha se uma cena com IA não tiver asset ativo", () => {
    expect(() => buildRenderManifest({ ...base, sceneVideos: new Map() })).toThrow(MissingAssetError);
  });
});
