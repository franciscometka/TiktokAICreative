import type { PresetQuality } from "./quality-presets";

/**
 * ÚNICO lugar com IDs de modelo do AI UGC. Hoje só existem os mocks. Os candidatos Google
 * (geração de imagem com referência + vídeo com fala nativa, estilo Veo/Flow) ficam DECLARADOS
 * como não verificados: antes de habilitar, confirmar na documentação oficial da API (Gemini API /
 * Vertex AI) o ID do modelo, o endpoint, as entradas aceitas, a tarifa e a política de pessoas.
 * Nunca automatizar a interface web do Flow.
 */

export const UGC_MOCK_PROVIDER = "mock";
/** Preço provisório (sem fonte oficial): só para a estimativa caber no fluxo. */
export const UGC_PLACEHOLDER_PROVIDER = "unassigned-ugc";

export const UGC_PRICING_REFS: Record<PresetQuality, { reference: { provider: string; model: string }; video: { provider: string; model: string } }> = {
  economy: { reference: { provider: UGC_PLACEHOLDER_PROVIDER, model: "reference-standard" }, video: { provider: UGC_PLACEHOLDER_PROVIDER, model: "ugc-video-economy" } },
  high: { reference: { provider: UGC_PLACEHOLDER_PROVIDER, model: "reference-standard" }, video: { provider: UGC_PLACEHOLDER_PROVIDER, model: "ugc-video-high" } },
  premium: { reference: { provider: UGC_PLACEHOLDER_PROVIDER, model: "reference-premium" }, video: { provider: UGC_PLACEHOLDER_PROVIDER, model: "ugc-video-premium" } },
};

export interface UgcModelCandidate {
  provider: "google";
  role: "reference_image" | "speaking_video";
  /** Rótulo do candidato; o ID exato é confirmado na doc oficial antes de ativar. */
  candidate: string;
  verified: false;
  notes: string;
}

export const GOOGLE_UGC_CANDIDATES: readonly UgcModelCandidate[] = [
  {
    provider: "google",
    role: "reference_image",
    candidate: "gemini-image-with-reference",
    verified: false,
    notes: "Imagem 9:16 de pessoa segurando o produto a partir da foto real (edição/composição com referência).",
  },
  {
    provider: "google",
    role: "speaking_video",
    candidate: "veo-image-to-video-with-audio",
    verified: false,
    notes: "Vídeo curto a partir da referência aprovada, com fala e áudio nativos (estratégia native_speech).",
  },
];
