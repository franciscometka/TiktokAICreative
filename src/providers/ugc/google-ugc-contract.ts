import { GOOGLE_UGC_CANDIDATES } from "@/config/ugc-models";
import type { UgcAudioStrategy } from "@/domain/ugc";
import type { UgcReferenceRequest, UgcVideoRequest } from "./ugc-providers";

/**
 * Contrato PREPARADO para um provider Google (geração de imagem com referência + vídeo com fala
 * nativa, no estilo Veo/Flow), SEM transporte. Monta só a intenção normalizada que um provider
 * oficial receberia; não chama rede, não conhece endpoint/ID definitivo e não lê segredo.
 *
 * Antes de criar o transporte real (providers/ugc/google-*-provider.ts):
 * 1. Confirmar na documentação oficial (Gemini API ou Vertex AI) modelos, endpoints, limites,
 *    formato de imagem de entrada, proporção 9:16, duração por clipe, áudio nativo e tarifa.
 * 2. Confirmar a política de geração de pessoas/rostos e de uso comercial.
 * 3. Registrar preço OFICIAL em config/pricing.ts (hoje é placeholder `unassigned-ugc`).
 * 4. Persistir intenção antes do POST e task id antes do polling (mesmo padrão do Presenter/Runway).
 * Nunca automatizar a interface web do Flow.
 */

export const GOOGLE_UGC_AUDIO_STRATEGY: UgcAudioStrategy = "native_speech";

export interface PreparedUgcCall {
  provider: "google";
  role: "reference_image" | "speaking_video";
  candidate: string;
  verified: false;
  /** Corpo normalizado (sem bytes, sem segredo) — o transporte real o converte para a API oficial. */
  input: Record<string, unknown>;
}

export function prepareGoogleUgcReference(request: UgcReferenceRequest): PreparedUgcCall {
  const candidate = GOOGLE_UGC_CANDIDATES.find((c) => c.role === "reference_image")!;
  return {
    provider: "google",
    role: "reference_image",
    candidate: candidate.candidate,
    verified: false,
    input: {
      prompt: request.prompt,
      referenceImage: request.product.imageUri,
      aspectRatio: request.aspectRatio,
      preserve: request.product.preserve,
      personGeneration: "adult_only_fictional",
    },
  };
}

export function prepareGoogleUgcVideo(request: UgcVideoRequest): PreparedUgcCall {
  if (request.audio) throw new Error("O candidato Google declara native_speech: não envia narração externa.");
  const candidate = GOOGLE_UGC_CANDIDATES.find((c) => c.role === "speaking_video")!;
  return {
    provider: "google",
    role: "speaking_video",
    candidate: candidate.candidate,
    verified: false,
    input: {
      image: request.reference.imageUri,
      prompt: `${request.action}. The person says, in Brazilian Portuguese: "${request.speech}"`,
      durationSeconds: request.durationSeconds,
      aspectRatio: request.aspectRatio,
      generateAudio: true,
    },
  };
}
