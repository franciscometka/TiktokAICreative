import type { CameraMove, GeneratedVisualSource, VideoDirection } from "@/domain/creative";

/**
 * Estratégia de cada tipo de cena gerada (patch de qualidade do Lote 5).
 * Fonte das regras de prompt: guias oficiais da Runway (Gen-4 Video Prompting Guide, Image to Video
 * Prompting Guide, Camera Terms) — descrever MOVIMENTO, não a imagem; frases positivas ("Locked
 * camera. The camera remains still." em vez de "the camera doesn't move"); começar simples.
 */

export interface SceneStrategyDefaults {
  /** Direção usada quando o planner não informar (planos antigos ou campos ausentes). */
  direction: VideoDirection;
}

export const VIDEO_STRATEGIES: Readonly<Record<GeneratedVisualSource, SceneStrategyDefaults>> = {
  // Produto-herói: produto INTEIRO, câmera estável ou deslocamento lateral leve. Zoom não é default.
  product_hero: {
    direction: { framing: "full_product", camera: "lateral_slide", subjectAction: "", ambientMotion: "soft light glides across the surface", pacing: "calm" },
  },
  // Produto em uso: a ação física é o ponto; câmera travada para a ação ler bem.
  product_demo: {
    direction: { framing: "in_context", camera: "locked", subjectAction: "a hand picks up the product and uses it naturally", ambientMotion: "", pacing: "steady" },
  },
  // Contexto/estilo de vida: ambiente vivo, câmera de celular suave.
  lifestyle: {
    direction: { framing: "in_context", camera: "handheld", subjectAction: "", ambientMotion: "gentle natural movement in the background", pacing: "steady" },
  },
  // Genérico (planos antigos): tratado como produto-herói sem receita.
  generated_video: {
    direction: { framing: "full_product", camera: "locked", subjectAction: "", ambientMotion: "", pacing: "calm" },
  },
  presenter: {
    direction: { framing: "person_medium", camera: "locked", subjectAction: "", ambientMotion: "", pacing: "steady" },
  },
  product_ugc: {
    direction: { framing: "person_medium", camera: "handheld", subjectAction: "the person shows and holds the product naturally", ambientMotion: "", pacing: "steady" },
  },
  // AI UGC (Lote 5.3): mesma pessoa da referência aprovada, segurando o produto real.
  ugc_hook: {
    direction: { framing: "person_medium", camera: "handheld", subjectAction: "the person holds the product near the face and speaks directly to the camera", ambientMotion: "", pacing: "energetic" },
  },
  ugc_demo: {
    direction: { framing: "person_medium", camera: "handheld", subjectAction: "the person turns the product slowly in the hands, showing its shape and details", ambientMotion: "", pacing: "steady" },
  },
  ugc_benefit: {
    direction: { framing: "person_medium", camera: "handheld", subjectAction: "the person points at one detail of the product while talking to the camera", ambientMotion: "", pacing: "steady" },
  },
  ugc_cta: {
    direction: { framing: "person_medium", camera: "locked", subjectAction: "the person holds the product toward the camera and smiles while speaking", ambientMotion: "", pacing: "steady" },
  },
  product_broll: {
    // Editor V2: B-roll CONTEXTUAL (mão, mesma bancada/ambiente da referência), nunca catálogo em fundo branco.
    direction: { framing: "in_context", camera: "handheld", subjectAction: "a hand slowly turns the product, showing a physical detail, in the same home environment as the reference", ambientMotion: "natural domestic light, real countertop", pacing: "steady" },
  },
};

/** Frases POSITIVAS de câmera (guia oficial: negação é imprevisível). */
export const CAMERA_PHRASES: Readonly<Record<CameraMove, string>> = {
  locked: "Locked camera. The camera remains still.",
  lateral_slide: "The camera slides slowly sideways, keeping the product centered.",
  slow_dolly_in: "The camera dollies in slowly over a short distance.",
  slow_dolly_out: "The camera dollies out slowly, revealing more of the scene.",
  orbit_arc: "The camera arcs slowly around the product.",
  handheld: "Handheld smartphone camera with subtle natural movement.",
  pan: "The camera pans slowly across the scene.",
  tilt: "The camera tilts slowly.",
};

export const FRAMING_PHRASES: Readonly<Record<VideoDirection["framing"], string>> = {
  full_product: "The entire product stays fully visible in frame, centered, with space around it.",
  product_detail: "Close framing on one detail of the product.",
  in_context: "The product sits naturally in the scene and stays clearly visible.",
  person_medium: "Medium shot of the person.",
};

export const PACING_PHRASES: Readonly<Record<VideoDirection["pacing"], string>> = {
  calm: "Slow, smooth motion for the whole clip.",
  steady: "Steady, natural pace.",
  energetic: "Lively, energetic pace.",
};

/** O que NUNCA deve mudar no produto (frase positiva, sempre presente em cenas com produto). */
export const PRODUCT_STABILITY = "The product keeps its exact shape, proportions, colors, label and logo.";
