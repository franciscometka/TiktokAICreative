import { describe, expect, it } from "vitest";
import { RenderManifestSchema, type RenderManifest } from "@/domain/render";
import type { ResolvedAsset } from "./asset-resolver";
import { buildCompositionProps, compositionHasAudio, COVER_MAX_ASPECT, OVERLAY_TIMING, PLACEHOLDER_LABEL } from "./composition-props";

const IMG = "data/uploads/prod_1/img_a.png";
const WIDE = "data/uploads/prod_1/img_b.png";

function manifest(overrides: Partial<RenderManifest> = {}): RenderManifest {
  return RenderManifestSchema.parse({
    campaignId: "campaign_1",
    creativeId: "creative_1",
    assets: [
      { sceneId: "s1", kind: "generated_video", uri: "mock://video/1.mp4", startSeconds: 0, durationSeconds: 3, motion: "none", shotType: "close_up", onScreenText: "Cena 1", visualSource: "generated_video", visualDescription: "mão abrindo a tampa" },
      { sceneId: "s2", kind: "product_image", uri: IMG, startSeconds: 3, durationSeconds: 3, motion: "ken_burns", shotType: "product_detail", transition: "fade", onScreenText: "Parede dupla", visualSource: "product_image" },
      { sceneId: "s3", kind: "product_image", uri: WIDE, startSeconds: 6, durationSeconds: 3, motion: "pan", shotType: "product_detail", transition: "cut", onScreenText: "Inox", visualSource: "product_image" },
      { sceneId: "s4", kind: "text_card", uri: null, startSeconds: 9, durationSeconds: 6, motion: "none", shotType: "text_card", onScreenText: "Gelada o dia todo", visualSource: "text_card" },
    ],
    audio: [{ kind: "narration", uri: "mock://audio/1.mp3", startSeconds: 0, durationSeconds: 15 }],
    captions: [
      { text: "Primeira", startSeconds: 0, endSeconds: 3 },
      { text: "Segunda", startSeconds: 3, endSeconds: 9 },
      { text: "Depois do CTA", startSeconds: 12, endSeconds: 15 },
    ],
    overlays: { productName: "Garrafa Térmica", priceBrl: 79.9, callToAction: "Garanta a sua", hook: "Sua água esquenta?" },
    duration: 15,
    generatedVideoSeconds: 3,
    output: { width: 1080, height: 1920, fps: 30, container: "mp4", path: "outputs/renders/campaign_1/creative_1" },
    ...overrides,
  });
}

const file = (uri: string, width: number, height: number): ResolvedAsset => ({
  kind: "file",
  media: "image",
  uri,
  absolutePath: `/abs/${uri}`,
  contentType: "image/png",
  size: { width, height },
});

const ASSETS = new Map<string, ResolvedAsset>([
  ["mock://video/1.mp4", { kind: "mock", uri: "mock://video/1.mp4" }],
  [IMG, file(IMG, 600, 900)],
  [WIDE, file(WIDE, 1200, 800)],
]);
const urlFor = (uri: string) => `http://127.0.0.1:1/assets/${encodeURIComponent(uri)}`;

describe("buildCompositionProps", () => {
  it("duração e cenas em frames vêm do manifest", () => {
    const { props } = buildCompositionProps({ manifest: manifest(), assets: ASSETS, urlFor });
    expect(props).toMatchObject({ fps: 30, width: 1080, height: 1920, durationInFrames: 450 });
    expect(props.scenes.map((s) => [s.startFrame, s.durationFrames])).toEqual([[0, 90], [90, 90], [180, 90], [270, 180]]);
  });

  it("vídeo IA mock vira placeholder explícito, nunca 'vídeo gerado'", () => {
    const { props, warnings } = buildCompositionProps({ manifest: manifest(), assets: ASSETS, urlFor });
    const s1 = props.scenes[0]!;
    expect(s1.kind).toBe("generated_video");
    expect(s1.placeholder).toEqual({ label: PLACEHOLDER_LABEL, description: null });
    expect(PLACEHOLDER_LABEL).toContain("MOCK");
    // Usa a foto real como fundo, inteira (contain), sem distorcer.
    expect(s1.image).toMatchObject({ src: urlFor(IMG), fit: "contain" });
    expect(warnings.some((w) => w.code === "generated_video_placeholder" && w.sceneId === "s1")).toBe(true);
  });

  it("descrição técnica no placeholder só em debug", () => {
    const { props } = buildCompositionProps({ manifest: manifest(), assets: ASSETS, urlFor, debug: true });
    expect(props.scenes[0]?.placeholder?.description).toBe("mão abrindo a tampa");
    expect(props.debug).toBe(true);
  });

  it("cover para imagem em pé, contain para imagem larga (sem distorção)", () => {
    const { props } = buildCompositionProps({ manifest: manifest(), assets: ASSETS, urlFor });
    expect(600 / 900).toBeLessThanOrEqual(COVER_MAX_ASPECT);
    expect(props.scenes[1]?.image).toEqual({ src: urlFor(IMG), width: 600, height: 900, fit: "cover" });
    expect(props.scenes[2]?.image).toEqual({ src: urlFor(WIDE), width: 1200, height: 800, fit: "contain" });
  });

  it("imagem ausente no disco → card de texto + aviso", () => {
    const assets = new Map(ASSETS);
    assets.set(WIDE, { kind: "missing", uri: WIDE });
    const { props, warnings } = buildCompositionProps({ manifest: manifest(), assets, urlFor });
    expect(props.scenes[2]).toMatchObject({ kind: "text_card", image: null });
    expect(warnings).toContainEqual(expect.objectContaining({ sceneId: "s3", code: "asset_file_missing" }));
  });

  it("sem áudio: nenhuma faixa e aviso sempre presente", () => {
    const { props, warnings } = buildCompositionProps({ manifest: manifest(), assets: ASSETS, urlFor });
    expect(props.audio).toEqual([]);
    expect(warnings.filter((w) => w.code === "audio_unavailable")).toHaveLength(1);
  });

  it("hook no início e CTA no fim, sem sobreposição", () => {
    const { props } = buildCompositionProps({ manifest: manifest(), assets: ASSETS, urlFor });
    expect(props.hook).toEqual({ text: "Sua água esquenta?", endFrame: 90 });
    // Última cena (6s) é maior que a janela do CTA → últimos 3.5s.
    expect(props.cta.startFrame).toBe(450 - OVERLAY_TIMING.ctaSeconds * 30);
    expect(props.cta.startFrame).toBeGreaterThan(props.hook!.endFrame);
  });

  it("hook cai para o texto da primeira cena quando o manifest não traz hook", () => {
    const m = manifest();
    const { props } = buildCompositionProps({ manifest: { ...m, overlays: { ...m.overlays, hook: undefined } }, assets: ASSETS, urlFor });
    expect(props.hook?.text).toBe("Cena 1");
  });

  it("legendas em frames, cortadas quando o CTA entra", () => {
    const { props } = buildCompositionProps({ manifest: manifest(), assets: ASSETS, urlFor });
    expect(props.captions).toEqual([
      { text: "Primeira", startFrame: 0, endFrame: 90 },
      { text: "Segunda", startFrame: 90, endFrame: 270 },
    ]);
    expect(props.captions.every((c) => c.endFrame <= props.cta.startFrame)).toBe(true);
  });

  it("preço formatado em BRL e nome/preço só no bloco de produto", () => {
    const { props } = buildCompositionProps({ manifest: manifest(), assets: ASSETS, urlFor });
    expect(props.product).toMatchObject({ name: "Garrafa Térmica", benefit: null });
    // Espaço inseparável do Intl: "R$" nunca quebra de linha longe do número.
    expect(props.product.priceLabel?.replace(/\s/g, " ")).toBe("R$ 79,90");
    const m = manifest();
    const noPrice = buildCompositionProps({ manifest: { ...m, overlays: { ...m.overlays, priceBrl: undefined } }, assets: ASSETS, urlFor });
    expect(noPrice.props.product.priceLabel).toBeNull();
  });

  it("primeira cena sempre entra em corte seco", () => {
    const m = manifest();
    const assets = m.assets.map((a, i) => (i === 0 ? { ...a, transition: "fade" as const } : a));
    const { props } = buildCompositionProps({ manifest: { ...m, assets }, assets: ASSETS, urlFor });
    expect(props.scenes[0]?.transition).toBe("cut");
    expect(props.scenes[1]?.transition).toBe("fade");
  });
});

describe("compositionHasAudio", () => {
  it("preserva áudio nativo de clipe mesmo sem faixa de narração", () => {
    expect(compositionHasAudio({ audio: [], scenes: [{ video: { src: "clip.mp4", muted: false } } as never] })).toBe(true);
    expect(compositionHasAudio({ audio: [], scenes: [{ video: { src: "clip.mp4", muted: true } } as never] })).toBe(false);
  });
});
