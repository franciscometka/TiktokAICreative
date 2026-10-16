import {
  GEMINI_UGC_REFERENCE_MODEL,
  GOOGLE_UGC_PROVIDER,
  type VeoModelConfig,
  veoRequestedDuration,
} from "@/config/ugc-models";
import type { UgcReferenceRequest, UgcVideoRequest } from "./ugc-providers";

/** Builders puros: URIs locais ainda serão convertidas em bytes/inlineData pelo transporte futuro. */
export interface GoogleImageGenerationRequest {
  provider: typeof GOOGLE_UGC_PROVIDER;
  model: typeof GEMINI_UGC_REFERENCE_MODEL;
  input: readonly [
    { type: "text"; text: string },
    { type: "image"; sourceUri: string; purpose: "preserve_product" },
  ];
  responseFormat: { type: "image"; mimeType: "image/png"; aspectRatio: "9:16"; imageSize: "1K" };
  safety: { personGeneration: "adult_synthetic_only" };
}

export interface VeoReferenceImage {
  image: { sourceUri: string };
  referenceType: "asset";
}

export interface VeoGenerateRequest {
  provider: typeof GOOGLE_UGC_PROVIDER;
  model: VeoModelConfig["model"];
  prompt: string;
  image: { sourceUri: string; approvedReferenceId: string; approvedReferenceVersion: string };
  config: {
    aspectRatio: "9:16";
    resolution: VeoModelConfig["resolution"];
    durationSeconds: "4" | "6" | "8";
    personGeneration: "allow_adult";
    numberOfVideos: 1;
    referenceImages?: readonly VeoReferenceImage[];
    seed?: number;
    generateAudio: true;
  };
  metadata: {
    editorialDurationSeconds: number;
    requestedDurationSeconds: 4 | 6 | 8;
    nativeAudio: true;
    seedIsDeterministic: false;
  };
}

export function buildGoogleUgcReferenceRequest(request: UgcReferenceRequest): GoogleImageGenerationRequest {
  return {
    provider: GOOGLE_UGC_PROVIDER,
    model: GEMINI_UGC_REFERENCE_MODEL,
    input: [
      {
        type: "text",
        text: `${request.prompt}\nEdit the supplied product image into a portrait 9:16 UGC reference. Preserve exactly: ${request.product.preserve.join(", ")}. Do not redesign, relabel or reshape the product. The person must be synthetic and adult.`,
      },
      { type: "image", sourceUri: request.product.imageUri, purpose: "preserve_product" },
    ],
    responseFormat: { type: "image", mimeType: "image/png", aspectRatio: "9:16", imageSize: "1K" },
    safety: { personGeneration: "adult_synthetic_only" },
  };
}

export function buildVeoUgcVideoRequest(request: UgcVideoRequest, model: VeoModelConfig): VeoGenerateRequest {
  if (!request.reference.approved) throw new Error("Veo exige uma referência UGC aprovada.");
  if (request.audio) throw new Error("Veo 3.1 usa áudio nativo: não envie narração ElevenLabs.");
  if (request.aspectRatio !== "9:16") throw new Error("AI UGC Veo deve permanecer em 9:16.");
  const extras = [...new Set(request.additionalReferenceUris ?? [])];
  if (extras.length > model.maxReferenceImages) throw new Error(`Veo aceita no máximo ${model.maxReferenceImages} referenceImages.`);
  if (extras.length > 0 && !model.supportsReferenceImages) throw new Error(`${model.model} não suporta referenceImages; use a referência UGC já composta com o produto.`);
  const duration = veoRequestedDuration(request.durationSeconds, model, extras.length);
  return {
    provider: GOOGLE_UGC_PROVIDER,
    model: model.model,
    prompt: `${request.action}. Keep the same adult synthetic person, face, hair, wardrobe, environment and exact product identity. Preserve product shape, colors, logo, packaging and proportions. The person says naturally in Brazilian Portuguese: "${request.speech}"`,
    image: {
      sourceUri: request.reference.imageUri,
      approvedReferenceId: request.reference.id,
      approvedReferenceVersion: request.reference.version,
    },
    config: {
      aspectRatio: "9:16",
      resolution: model.resolution,
      durationSeconds: String(duration) as "4" | "6" | "8",
      personGeneration: "allow_adult",
      numberOfVideos: 1,
      ...(extras.length ? { referenceImages: extras.map(sourceUri => ({ image: { sourceUri }, referenceType: "asset" as const })) } : {}),
      ...(request.seed === undefined ? {} : { seed: request.seed }),
      generateAudio: true,
    },
    metadata: {
      editorialDurationSeconds: request.durationSeconds,
      requestedDurationSeconds: duration,
      nativeAudio: true,
      seedIsDeterministic: false,
    },
  };
}

// Nome antigo preservado para consumidores do Lote 5.3.
export const prepareGoogleUgcReference = buildGoogleUgcReferenceRequest;
