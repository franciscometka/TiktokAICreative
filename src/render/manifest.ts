import { generatedVideoSeconds, type CreativePlan } from "@/domain/creative";
import type { ProductInput } from "@/domain/product";
import {
  RenderManifestSchema,
  VIDEO_FORMAT,
  type ManifestAsset,
  type RenderManifest,
  type RenderWarning,
} from "@/domain/render";
import { segmentNarration } from "./captions";
import { sceneStrategy } from "./scene-strategy";

export class MissingAssetError extends Error {
  override name = "MissingAssetError";
}

export interface BuildManifestInput {
  campaignId: string;
  plan: CreativePlan;
  product: ProductInput;
  /** sceneId → URI do vídeo gerado ATIVO daquela cena (pode ser "mock://..."). */
  sceneVideos: ReadonlyMap<string, string>;
  narration?: { uri: string; durationSeconds: number };
  outputDir: string;
}

/**
 * Função PURA: plano + assets → manifest de renderização. O manifest é TUDO o que o renderer
 * precisa (o Remotion não recebe o CampaignPlan). A estratégia de cada cena vem de
 * sceneStrategy(visualSource); cenas sem vídeo IA usam a imagem do produto com o movimento
 * planejado (ou composição de texto), o que permite vídeo final mais longo que os segundos de IA.
 */
export function buildRenderManifest(input: BuildManifestInput): RenderManifest {
  const { plan, product, sceneVideos } = input;
  const images = product.images;
  const warnings: RenderWarning[] = [];
  let cursor = 0;
  let imageIndex = 0;

  const assets: ManifestAsset[] = plan.scenes.map((scene) => {
    const start = cursor;
    cursor += scene.duration;
    const base = {
      sceneId: scene.id,
      startSeconds: start,
      durationSeconds: scene.duration,
      shotType: scene.shotType,
      transition: scene.transition,
      onScreenText: scene.onScreenText,
      visualSource: scene.visualSource,
      visualDescription: scene.visualDescription,
    };

    const strategy = sceneStrategy(scene.visualSource, images.length > 0);
    if (strategy.warning) warnings.push({ ...strategy.warning, sceneId: scene.id });

    if (strategy.kind === "generated_video") {
      const uri = sceneVideos.get(scene.id);
      if (!uri) throw new MissingAssetError(`Cena ${scene.id} exige vídeo gerado, mas não há asset ativo`);
      return { ...base, kind: "generated_video", uri, motion: "none" };
    }
    if (strategy.kind === "product_image") {
      const image = images[imageIndex % images.length];
      imageIndex += 1;
      if (image) return { ...base, kind: "product_image", uri: image.uri, motion: scene.motion };
    }
    return { ...base, kind: "text_card", uri: null, motion: scene.motion };
  });

  const captions = plan.scenes.flatMap((scene, i) => {
    const start = assets[i]?.startSeconds ?? 0;
    return segmentNarration(scene.narration, start, start + scene.duration);
  });

  return RenderManifestSchema.parse({
    campaignId: input.campaignId,
    creativeId: plan.id,
    assets,
    audio: input.narration
      ? [{ kind: "narration", uri: input.narration.uri, startSeconds: 0, durationSeconds: input.narration.durationSeconds }]
      : [],
    captions,
    overlays: {
      productName: product.name,
      priceBrl: product.priceBrl,
      callToAction: plan.callToAction,
      hook: plan.hook,
      benefit: product.benefits[0],
    },
    duration: plan.duration,
    generatedVideoSeconds: generatedVideoSeconds(plan),
    output: {
      ...VIDEO_FORMAT,
      path: `${input.outputDir}/renders/${input.campaignId}/${plan.id}`,
    },
    warnings,
  });
}
