/**
 * Contrato SERIALIZÁVEL entre o app (src/render/composition-props.ts) e a composição Remotion.
 * Tudo já vem em frames e com URLs prontas: a composição não calcula timing nem resolve caminhos.
 * Sem dependências: este arquivo é importado pelos dois lados.
 */

export const COMPOSITION_ID = "TikTokCreative";
export const COMPOSITION_VERSION = "tiktok-creative@1.3.0";

/** Mesmos valores de SceneAssetKind / VisualSource / Motion / Transition do domínio. */
export type SceneKind = "generated_video" | "product_image" | "text_card";
export type SceneVisualSource =
  | "generated_video"
  | "product_hero" | "product_demo" | "lifestyle" | "presenter" | "product_ugc"
  | "ugc_hook" | "ugc_demo" | "ugc_benefit" | "ugc_cta" | "product_broll"
  | "product_image"
  | "text_card"
  | "screenshot"
  | "simple_background"
  | "existing_asset"
  | "reference_detail";
export type SceneMotion = "none" | "ken_burns" | "pan" | "zoom_in" | "crop";
export type SceneTransition = "cut" | "fade" | "slide" | "zoom";

export interface ImageProps {
  src: string;
  width: number;
  height: number;
  /** cover = preenche a tela; contain = produto inteiro sobre fundo desfocado. */
  fit: "cover" | "contain";
}

export interface SceneProps {
  id: string;
  index: number;
  startFrame: number;
  durationFrames: number;
  kind: SceneKind;
  visualSource: SceneVisualSource | null;
  motion: SceneMotion;
  transition: SceneTransition;
  onScreenText: string;
  image: ImageProps | null;
  /** muted=false só em cenas AI UGC com fala nativa (o clipe é a voz; não há narração por cima). */
  video?: { src: string; fit?: "contain"; muted?: boolean };
  /** Presente quando a cena é um vídeo IA ainda simulado. */
  placeholder: { label: string; description: string | null } | null;
}

export interface CaptionProps {
  text: string;
  startFrame: number;
  endFrame: number;
}

/** Creative Editor V2 (Lote 5.6): espelho serializável do Edit Plan, já em frames. */
export type EditTransitionName = "straight_cut" | "match_cut" | "cut_on_action" | "object_wipe" | "punch_in" | "crossfade";

export interface EditVisualProps {
  id: string;
  startFrame: number;
  durationFrames: number;
  role: "aroll" | "broll";
  /** placeholder = asset simulado (mock) ou ausente; nunca parece mídia gerada. */
  kind: "video" | "image" | "placeholder";
  src: string | null;
  /** Frames do início do clipe descartados (handle / continuação do A-roll). */
  trimBeforeFrames: number;
  /** punch-in sutil (1 = sem). */
  scale: number;
  /** Recorte do frame de referência (B-roll de detalhe) com push-in lento. */
  crop: { focusX: number; focusY: number; scaleFrom: number; scaleTo: number } | null;
  transition: EditTransitionName;
  placeholderLabel: string | null;
}

export interface EditAudioProps {
  src: string;
  startFrame: number;
  durationFrames: number;
  trimBeforeFrames: number;
  gain: number;
  fadeInFrames: number;
  fadeOutFrames: number;
}

export interface EditProps {
  version: 2;
  visuals: EditVisualProps[];
  /** Áudio SEPARADO do visual: só as faixas de A-roll; todo visual é mudo. */
  audio: EditAudioProps[];
  captions: (CaptionProps & { emphasis: string[] })[];
  hook: { text: string; endFrame: number } | null;
  cta: { text: string; startFrame: number; endFrame: number } | null;
}

export interface CreativeProps {
  [key: string]: unknown;
  meta: { creativeId: string; campaignId: string | null; compositionVersion: string };
  fps: number;
  width: number;
  height: number;
  durationInFrames: number;
  scenes: SceneProps[];
  captions: CaptionProps[];
  hook: { text: string; endFrame: number } | null;
  cta: { text: string; startFrame: number };
  product: { name: string; priceLabel: string | null; benefit: string | null };
  /** Faixas de áudio reais (narração TTS, Lote 4). Vazio = vídeo sem som. */
  audio: { src: string; startFrame: number }[];
  /** Mostra descrições técnicas no placeholder (só para desenvolvimento). */
  debug: boolean;
  /** Presente = Editor V2 (a composição usa o Edit Plan e ignora scenes/captions/cta lineares). */
  edit?: EditProps;
}
