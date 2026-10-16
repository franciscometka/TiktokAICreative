import type { PresetQuality } from "./quality-presets";

/**
 * Modelos oficiais candidatos para a futura integração AI UGC.
 *
 * A seleção REAL continua desabilitada: estes IDs servem apenas para contratos, estimativas e
 * testes offline. Fontes consultadas em 2026-10-16:
 * - https://ai.google.dev/gemini-api/docs/image-generation
 * - https://ai.google.dev/gemini-api/docs/veo
 * - https://ai.google.dev/gemini-api/docs/pricing
 */
export const GOOGLE_UGC_PROVIDER = "google";
export const UGC_MOCK_PROVIDER = "mock";

export const GEMINI_UGC_REFERENCE_MODEL = "gemini-3.1-flash-image";
export const VEO_3_1_MODELS = {
  lite: "veo-3.1-lite-generate-preview",
  fast: "veo-3.1-fast-generate-preview",
  standard: "veo-3.1-generate-preview",
} as const;

export type VeoTier = keyof typeof VEO_3_1_MODELS;
export type VeoModel = (typeof VEO_3_1_MODELS)[VeoTier];
export type VeoResolution = "720p" | "1080p";
export type VeoDurationSeconds = 4 | 6 | 8;
export type UgcPremiumVeoTier = "fast" | "standard";

export interface VeoModelConfig {
  provider: typeof GOOGLE_UGC_PROVIDER;
  model: VeoModel;
  tier: VeoTier;
  resolution: VeoResolution;
  aspectRatio: "9:16";
  nativeAudio: true;
  supportsImageToVideo: true;
  supportsReferenceImages: boolean;
  maxReferenceImages: 3;
  allowedDurations: readonly VeoDurationSeconds[];
}

function veoConfig(tier: VeoTier, resolution: VeoResolution): VeoModelConfig {
  return {
    provider: GOOGLE_UGC_PROVIDER,
    model: VEO_3_1_MODELS[tier],
    tier,
    resolution,
    aspectRatio: "9:16",
    nativeAudio: true,
    supportsImageToVideo: true,
    supportsReferenceImages: tier !== "lite",
    maxReferenceImages: 3,
    allowedDurations: [4, 6, 8],
  };
}

/** Estratégia inicial: Econômico Lite 720p; Equilibrado Fast 720p; Premium Fast 1080p. */
export function ugcVeoPreset(quality: PresetQuality, premiumTier: UgcPremiumVeoTier = "fast"): VeoModelConfig {
  if (quality === "economy") return veoConfig("lite", "720p");
  if (quality === "high") return veoConfig("fast", "720p");
  return veoConfig(premiumTier, "1080p");
}

/** Resolve o modelo+resolução guardado no PricingRef sem depender de env ou transporte. */
export function veoConfigForPricingModel(pricingModel: string): VeoModelConfig {
  const resolution: VeoResolution = pricingModel.endsWith(":1080p") ? "1080p" : "720p";
  const model = pricingModel.replace(/:1080p$/, "");
  const tier = Object.entries(VEO_3_1_MODELS).find(([, id]) => id === model)?.[0] as VeoTier | undefined;
  if (!tier) throw new Error(`Modelo Veo 3.1 não reconhecido: ${pricingModel}`);
  return veoConfig(tier, resolution);
}

/**
 * Duração faturável/pedida ao Veo. 1080p e referenceImages exigem 8s. Nos demais casos escolhemos
 * a menor duração oficial que cubra a duração editorial; o Remotion pode aparar o excedente.
 */
export function veoRequestedDuration(
  editorialSeconds: number,
  config: Pick<VeoModelConfig, "resolution">,
  referenceImageCount = 0,
): VeoDurationSeconds {
  if (!Number.isFinite(editorialSeconds) || editorialSeconds <= 0) throw new RangeError("Duração editorial do Veo precisa ser positiva.");
  if (referenceImageCount > 0 || config.resolution === "1080p") return 8;
  if (editorialSeconds <= 4) return 4;
  if (editorialSeconds <= 6) return 6;
  return 8;
}

export type UgcPricingRefs = { reference: { provider: string; model: string }; video: { provider: string; model: string } };

export function ugcPricingRefs(quality: PresetQuality, premiumTier: UgcPremiumVeoTier = "fast"): UgcPricingRefs {
  const veo = ugcVeoPreset(quality, premiumTier);
  return {
    reference: { provider: GOOGLE_UGC_PROVIDER, model: GEMINI_UGC_REFERENCE_MODEL },
    video: { provider: GOOGLE_UGC_PROVIDER, model: `${veo.model}${veo.resolution === "1080p" ? ":1080p" : ""}` },
  };
}

export const UGC_PRICING_REFS: Record<PresetQuality, UgcPricingRefs> = {
  economy: ugcPricingRefs("economy"),
  high: ugcPricingRefs("high"),
  premium: ugcPricingRefs("premium"),
};

export const GOOGLE_UGC_CANDIDATES = [
  { provider: GOOGLE_UGC_PROVIDER, role: "reference_image", model: GEMINI_UGC_REFERENCE_MODEL, verified: true,
    notes: "Nano Banana 2: edição text+image→image 9:16 usando a foto original do produto." },
  ...Object.entries(VEO_3_1_MODELS).map(([tier, model]) => ({
    provider: GOOGLE_UGC_PROVIDER,
    role: "speaking_video" as const,
    model,
    verified: true as const,
    notes: `Veo 3.1 ${tier}: image-to-video 9:16 com áudio nativo; 4/6/8s conforme restrições do modelo.`,
  })),
] as const;
