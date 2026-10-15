import {
  CAMERA_PHRASES,
  FRAMING_PHRASES,
  PACING_PHRASES,
  PRODUCT_STABILITY,
  VIDEO_STRATEGIES,
} from "@/config/video-strategies";
import type { GeneratedVisualSource, ScenePlan, VideoDirection } from "@/domain/creative";

/**
 * Prompt de vídeo ESTRUTURADO e determinístico (patch de qualidade do Lote 5). Segue os guias
 * oficiais da Runway: o prompt descreve MOVIMENTO (câmera, ação, ambiente), não a imagem de
 * referência; frases positivas; uma ação principal. Nada de claims: o texto vem só da direção.
 */

const clean = (text: string) => text.trim().replace(/\s+/g, " ").replace(/[.\s]+$/, "");
const sentence = (text: string) => (clean(text) ? `${clean(text)[0]!.toUpperCase()}${clean(text).slice(1)}.` : "");

/** Direção efetiva: a do plano, completada pelos defaults do tipo de cena. */
export function effectiveDirection(source: GeneratedVisualSource, direction: VideoDirection | undefined): VideoDirection {
  const defaults = VIDEO_STRATEGIES[source].direction;
  if (!direction) return defaults;
  return {
    ...direction,
    subjectAction: direction.subjectAction.trim() || defaults.subjectAction,
    ambientMotion: direction.ambientMotion.trim() || defaults.ambientMotion,
  };
}

/**
 * Ordem: enquadramento → câmera → ação do objeto/pessoa → ambiente → o que permanece estável → ritmo.
 * Ex.: "The entire product stays fully visible… Locked camera. The camera remains still. A hand…"
 */
export function buildMotionPrompt(source: GeneratedVisualSource, direction: VideoDirection | undefined): string {
  const d = effectiveDirection(source, direction);
  const parts = [
    FRAMING_PHRASES[d.framing],
    CAMERA_PHRASES[d.camera],
    sentence(d.subjectAction),
    sentence(d.ambientMotion),
    source === "presenter" ? "" : PRODUCT_STABILITY,
    PACING_PHRASES[d.pacing],
  ];
  return parts.filter(Boolean).join(" ").slice(0, 1000);
}

/** Prompt da cena para o provider: direção estruturada ou defaults seguros para planos antigos. */
export function scenePromptFor(scene: Pick<ScenePlan, "visualSource" | "generationPrompt" | "videoDirection">, source: GeneratedVisualSource): string {
  return buildMotionPrompt(source, scene.videoDirection);
}
