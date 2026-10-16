import { generatedVideoSeconds, type CreativePlan } from "@/domain/creative";
import type { ProductInput } from "@/domain/product";
import {
  RenderManifestSchema,
  VIDEO_FORMAT,
  type ManifestAsset,
  type RenderManifest,
  type RenderWarning,
} from "@/domain/render";
import type { NarrationTiming } from "@/domain/audio";
import { captionsFromWords } from "@/speech/timed-captions";
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
  /** AI UGC (native_speech): cenas cujo clipe traz a fala. Nunca junto com narração real separada. */
  clipAudioSceneIds?: ReadonlySet<string>;
  narration?: {
    uri: string;
    durationSeconds: number;
    isMock?: boolean;
    /** Timing real da fala (Lote 4). Ausente = legendas estimadas por cena. */
    timing?: NarrationTiming;
    /** Segundos a acrescentar no fim para a fala caber (AudioFit). Nunca corta fala. */
    extendSeconds?: number;
  };
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
  // Nunca duas vozes: fala nativa dos clipes UGC exclui uma narração real separada (D79).
  if ((input.clipAudioSceneIds?.size ?? 0) > 0 && input.narration && input.narration.isMock === false) {
    throw new Error("Áudio duplicado: clipes AI UGC com fala nativa não podem ser combinados com narração separada.");
  }
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
      return { ...base, kind: "generated_video", uri, motion: "none", ...(input.clipAudioSceneIds?.has(scene.id) ? { clipAudio: true } : {}) };
    }
    if (strategy.kind === "product_image") {
      const image = images[imageIndex % images.length];
      imageIndex += 1;
      if (image) return { ...base, kind: "product_image", uri: image.uri, motion: scene.motion };
    }
    return { ...base, kind: "text_card", uri: null, motion: scene.motion };
  });

  // Fala real mais longa que o plano: estende a ÚLTIMA cena (o CTA) — a narração nunca é cortada.
  const extendedSeconds = Math.max(0, Math.round((input.narration?.extendSeconds ?? 0) * 1000) / 1000);
  const last = assets[assets.length - 1];
  if (extendedSeconds > 0 && last) {
    last.durationSeconds = Math.round((last.durationSeconds + extendedSeconds) * 1000) / 1000;
    warnings.push({ sceneId: last.sceneId, code: "timeline_extended", message: `Narração real mais longa que o plano: o fim do vídeo ganhou ${extendedSeconds.toFixed(1).replace(".", ",")}s.` });
  }

  const timing = input.narration?.timing;
  const realAudio = input.narration !== undefined && input.narration.isMock === false;
  if (realAudio && !timing) {
    warnings.push({ sceneId: null, code: "captions_estimated", message: "Narração real sem timing confiável: legendas estimadas por cena." });
  }
  const captions = timing
    ? captionsFromWords(timing.words)
    : plan.scenes.flatMap((scene, i) => {
        const start = assets[i]?.startSeconds ?? 0;
        return segmentNarration(scene.narration, start, start + scene.duration);
      });

  return RenderManifestSchema.parse({
    campaignId: input.campaignId,
    creativeId: plan.id,
    assets,
    audio: input.narration
      ? [
          {
            kind: "narration",
            uri: input.narration.uri,
            startSeconds: 0,
            durationSeconds: input.narration.durationSeconds,
            isMock: input.narration.isMock ?? input.narration.uri.startsWith("mock://"),
            speechEndSeconds: timing?.speechEndSeconds,
          },
        ]
      : [],
    captions,
    captionSource: timing ? "alignment" : "estimated",
    extendedSeconds,
    overlays: {
      productName: product.name,
      priceBrl: product.priceBrl,
      callToAction: plan.callToAction,
      hook: plan.hook,
      benefit: product.benefits[0],
    },
    duration: Math.round((plan.duration + extendedSeconds) * 1000) / 1000,
    generatedVideoSeconds: generatedVideoSeconds(plan),
    output: {
      ...VIDEO_FORMAT,
      path: `${input.outputDir}/renders/${input.campaignId}/${plan.id}`,
    },
    warnings,
  });
}
