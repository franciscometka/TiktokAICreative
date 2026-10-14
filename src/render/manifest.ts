import { generatedVideoSeconds, type CreativePlan, type ScenePlan } from "@/domain/creative";
import type { ProductInput } from "@/domain/product";
import {
  RenderManifestSchema,
  VIDEO_FORMAT,
  type ManifestAsset,
  type RenderManifest,
} from "@/domain/render";

export class MissingAssetError extends Error {
  override name = "MissingAssetError";
}

export interface BuildManifestInput {
  campaignId: string;
  plan: CreativePlan;
  product: ProductInput;
  /** sceneId → URI do vídeo gerado ATIVO daquela cena. */
  sceneVideos: ReadonlyMap<string, string>;
  narration?: { uri: string; durationSeconds: number };
  outputDir: string;
}

/** Fontes visuais que usam uma imagem do produto (screenshot/asset existente ainda caem aqui — ver TASKS). */
const IMAGE_SOURCES: ReadonlySet<ScenePlan["visualSource"]> = new Set(["product_image", "screenshot", "existing_asset"]);

/**
 * Função PURA: plano + assets → manifest de renderização.
 * Cenas sem vídeo IA viram imagem do produto com o movimento planejado (ou card de texto),
 * o que permite vídeo final mais longo que os segundos gerados por IA.
 */
export function buildRenderManifest(input: BuildManifestInput): RenderManifest {
  const { plan, product, sceneVideos } = input;
  const images = product.images;
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
    };

    if (scene.requiresGeneratedVideo) {
      const uri = sceneVideos.get(scene.id);
      if (!uri) throw new MissingAssetError(`Cena ${scene.id} exige vídeo gerado, mas não há asset ativo`);
      return { ...base, kind: "generated_video", uri, motion: "none" };
    }
    const image =
      IMAGE_SOURCES.has(scene.visualSource) && images.length > 0 ? images[imageIndex % images.length] : undefined;
    if (image) {
      imageIndex += 1;
      return { ...base, kind: "product_image", uri: image.uri, motion: scene.motion };
    }
    return { ...base, kind: "text_card", uri: null, motion: scene.motion };
  });

  const captions = plan.scenes
    .map((scene, i) => ({ scene, start: assets[i]?.startSeconds ?? 0 }))
    .filter(({ scene }) => scene.narration.trim().length > 0)
    .map(({ scene, start }) => ({
      text: scene.narration,
      startSeconds: start,
      endSeconds: start + scene.duration,
    }));

  return RenderManifestSchema.parse({
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
    },
    duration: plan.duration,
    generatedVideoSeconds: generatedVideoSeconds(plan),
    output: {
      ...VIDEO_FORMAT,
      path: `${input.outputDir}/${input.campaignId}/${plan.id}.mp4`,
    },
  });
}
