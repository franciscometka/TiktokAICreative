import type { RenderManifest, RenderWarning } from "@/domain/render";
import { formatBrl } from "@/lib/money";
import {
  COMPOSITION_VERSION,
  type CreativeProps,
  type ImageProps,
  type SceneProps,
} from "../../remotion/types/props";
import type { ResolvedAsset } from "./asset-resolver";
import { sceneTimeline, secondsToFrames, totalFrames } from "./timeline";

/**
 * Função PURA: RenderManifest + assets resolvidos → props da composição Remotion.
 * Aqui ficam as decisões de layout dependentes de dados (cover × contain, janelas do hook e do
 * CTA, legendas em frames); a composição só desenha.
 */

export const PLACEHOLDER_LABEL = "MOCK · VÍDEO IA";

export const OVERLAY_TIMING = {
  hookMaxSeconds: 3,
  hookMinSeconds: 1.5,
  /** O CTA ocupa o fim do vídeo: a última cena ou, se ela for longa, os últimos N segundos. */
  ctaSeconds: 3.5,
} as const;

/** Imagens mais "em pé" que isso ocupam a tela inteira (cover); as demais aparecem inteiras. */
export const COVER_MAX_ASPECT = 0.7;

export interface BuildPropsInput {
  manifest: RenderManifest;
  /** uri do manifest → resultado do AssetResolver. */
  assets: ReadonlyMap<string, ResolvedAsset>;
  /** uri autorizada → URL que o navegador do Remotion consegue baixar. */
  urlFor: (uri: string) => string;
  debug?: boolean;
}

export interface BuiltProps {
  props: CreativeProps;
  warnings: RenderWarning[];
}

function imageProps(asset: ResolvedAsset | undefined, urlFor: (uri: string) => string): ImageProps | null {
  if (asset?.kind !== "file") return null;
  const aspect = asset.size.width / asset.size.height;
  return {
    src: urlFor(asset.uri),
    width: asset.size.width,
    height: asset.size.height,
    fit: aspect <= COVER_MAX_ASPECT ? "cover" : "contain",
  };
}

const isRealAudio = (uri: string) => !uri.startsWith("mock://");

export function buildCompositionProps({ manifest, assets, urlFor, debug = false }: BuildPropsInput): BuiltProps {
  const fps = manifest.output.fps;
  const warnings: RenderWarning[] = [...manifest.warnings];
  const timeline = sceneTimeline(
    manifest.assets.map((a) => a.durationSeconds),
    manifest.duration,
    fps,
  );
  const total = totalFrames(manifest.duration, fps);

  // Imagem de apoio para placeholders: a primeira foto real do produto disponível.
  const backdrop = manifest.assets
    .filter((a) => a.kind === "product_image" && a.uri)
    .map((a) => imageProps(assets.get(a.uri ?? ""), urlFor))
    .find((i) => i !== null);

  const scenes: SceneProps[] = manifest.assets.map((asset, index) => {
    const frames = timeline[index] ?? { startFrame: 0, durationFrames: 1 };
    const base = {
      id: asset.sceneId,
      index,
      startFrame: frames.startFrame,
      durationFrames: frames.durationFrames,
      visualSource: asset.visualSource ?? null,
      motion: asset.motion,
      transition: index === 0 ? ("cut" as const) : (asset.transition ?? "cut"),
      onScreenText: asset.onScreenText,
    };

    if (asset.kind === "generated_video") {
      const resolved = asset.uri ? assets.get(asset.uri) : undefined;
      // Lote 3: só existe provider mock. Um vídeo real (Lote 5) entra aqui como mídia de vídeo.
      warnings.push({
        sceneId: asset.sceneId,
        code: "generated_video_placeholder",
        message: `Cena ${index + 1}: vídeo IA simulado (${resolved?.kind === "mock" ? "provider mock" : "sem arquivo"}); usando placeholder.`,
      });
      return {
        ...base,
        kind: "generated_video",
        image: backdrop ? { ...backdrop, fit: "contain" } : null,
        placeholder: { label: PLACEHOLDER_LABEL, description: debug ? (asset.visualDescription ?? null) : null },
      };
    }

    if (asset.kind === "product_image" && asset.uri) {
      const resolved = assets.get(asset.uri);
      const image = imageProps(resolved, urlFor);
      if (image) return { ...base, kind: "product_image", image, placeholder: null };
      warnings.push({
        sceneId: asset.sceneId,
        code: "asset_file_missing",
        message: `Cena ${index + 1}: imagem ${asset.uri} não encontrada; usando composição de texto.`,
      });
    }
    return { ...base, kind: "text_card", image: null, placeholder: null };
  });

  const first = scenes[0];
  const last = scenes[scenes.length - 1];
  const hookText = (manifest.overlays.hook ?? first?.onScreenText ?? "").trim();
  const hookEnd = Math.min(
    total,
    Math.max(
      secondsToFrames(OVERLAY_TIMING.hookMinSeconds, fps),
      Math.min((first?.startFrame ?? 0) + (first?.durationFrames ?? 0), secondsToFrames(OVERLAY_TIMING.hookMaxSeconds, fps)),
    ),
  );
  const ctaStart = Math.min(
    total - 1,
    Math.max(last?.startFrame ?? 0, total - secondsToFrames(OVERLAY_TIMING.ctaSeconds, fps), hookText ? hookEnd : 0),
  );

  // Legendas param quando o CTA entra (o CTA ocupa a mesma faixa da tela).
  const captions = manifest.captions
    .map((c) => ({ text: c.text, startFrame: secondsToFrames(c.startSeconds, fps), endFrame: secondsToFrames(c.endSeconds, fps) }))
    .filter((c) => c.startFrame < ctaStart && c.endFrame > c.startFrame)
    .map((c) => ({ ...c, endFrame: Math.min(c.endFrame, ctaStart) }));

  // Lote 3: a composição ainda não toca áudio (TTS real = Lote 4). Nenhuma voz é sintetizada aqui.
  const realAudio = manifest.audio.filter((a) => isRealAudio(a.uri));
  warnings.push({
    sceneId: null,
    code: "audio_unavailable",
    message:
      realAudio.length === 0
        ? "Sem narração real (áudio do provider mock): vídeo renderizado sem som."
        : "Faixa de áudio real ignorada: o renderer ainda não mixa áudio (Lote 4). Vídeo sem som.",
  });

  const props: CreativeProps = {
    meta: {
      creativeId: manifest.creativeId,
      campaignId: manifest.campaignId ?? null,
      compositionVersion: COMPOSITION_VERSION,
    },
    fps,
    width: manifest.output.width,
    height: manifest.output.height,
    durationInFrames: total,
    scenes,
    captions,
    hook: hookText ? { text: hookText, endFrame: hookEnd } : null,
    cta: { text: manifest.overlays.callToAction, startFrame: ctaStart },
    product: {
      name: manifest.overlays.productName,
      priceLabel: manifest.overlays.priceBrl !== undefined ? formatBrl(manifest.overlays.priceBrl) : null,
      benefit: manifest.overlays.benefit ?? null,
    },
    // Áudio real chega no Lote 4; até lá nenhuma faixa é passada (nem sintetizada).
    audio: [],
    debug,
  };
  return { props, warnings };
}
