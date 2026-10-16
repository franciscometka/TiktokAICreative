import type { PresetQuality } from "./quality-presets";
import type { UgcPricingRefs } from "./ugc-models";

/**
 * Modelos do AI UGC via Krea API (alternativa ao Google, `UGC_PROVIDER=krea`). Arquivo SEPARADO do
 * Google: nada aqui altera `ugc-models.ts` nem os transportes Gemini/Veo diretos.
 *
 * Fonte oficial consultada em 2026-10-16: OpenAPI `https://api.krea.ai/openapi.json` (campos de
 * request, `x-krea-pricing`), guias `https://www.krea.ai/docs/developers/*` (Bearer token, `POST /assets`,
 * `GET /jobs/{id}`). Preços FIXOS por requisição em USD; com áudio, o preço cresce linear com 4/6/8s.
 */
export const KREA_UGC_PROVIDER = "krea";
export const KREA_API_BASE = "https://api.krea.ai";

/** Nano Banana 2 na Krea: texto + imagens (via URL de asset) → imagem 9:16. */
export const KREA_UGC_REFERENCE_MODEL = "nano-banana-2";
export const KREA_REFERENCE_ENDPOINT = "/generate/image/google/nano-banana-2";

/**
 * Veo 3.1 na Krea. Só Fast e Standard aceitam `generate_audio` (a variante Lite da Krea não tem
 * áudio nativo) — por isso o AI UGC (fala nativa) usa Fast mesmo no Econômico.
 */
export const KREA_VEO_MODELS = { fast: "veo-3.1-fast", standard: "veo-3.1" } as const;
export type KreaVeoTier = keyof typeof KREA_VEO_MODELS;
export type KreaVeoResolution = "720p" | "1080p";
export type KreaVeoDuration = 4 | 6 | 8;

export interface KreaVeoConfig {
  provider: typeof KREA_UGC_PROVIDER;
  model: (typeof KREA_VEO_MODELS)[KreaVeoTier];
  tier: KreaVeoTier;
  endpoint: string;
  resolution: KreaVeoResolution;
  aspectRatio: "9:16";
  nativeAudio: true;
  allowedDurations: readonly KreaVeoDuration[];
}

function config(tier: KreaVeoTier, resolution: KreaVeoResolution): KreaVeoConfig {
  const model = KREA_VEO_MODELS[tier];
  return { provider: KREA_UGC_PROVIDER, model, tier, endpoint: `/generate/video/google/${model}`, resolution, aspectRatio: "9:16", nativeAudio: true, allowedDurations: [4, 6, 8] };
}

/** Modelo+resolução guardados no PricingRef (`veo-3.1-fast` ou `veo-3.1-fast:1080p`). */
export function kreaVeoConfigForPricingModel(pricingModel: string): KreaVeoConfig {
  const resolution: KreaVeoResolution = pricingModel.endsWith(":1080p") ? "1080p" : "720p";
  const model = pricingModel.replace(/:1080p$/, "");
  const tier = (Object.entries(KREA_VEO_MODELS).find(([, id]) => id === model)?.[0]) as KreaVeoTier | undefined;
  if (!tier) throw new Error(`Modelo Veo da Krea não reconhecido: ${pricingModel}`);
  return config(tier, resolution);
}

/** Menor duração oficial (4/6/8s) que cobre a duração editorial; o Remotion apara o excedente. */
export function kreaRequestedDuration(editorialSeconds: number): KreaVeoDuration {
  if (!Number.isFinite(editorialSeconds) || editorialSeconds <= 0) throw new RangeError("Duração editorial do Veo (Krea) precisa ser positiva.");
  if (editorialSeconds <= 4) return 4;
  if (editorialSeconds <= 6) return 6;
  return 8;
}

/** Econômico/Equilibrado: Veo 3.1 Fast 720p com áudio; Premium: Fast 1080p. */
export function kreaUgcPricingRefs(quality: PresetQuality): UgcPricingRefs {
  const video = quality === "premium" ? `${KREA_VEO_MODELS.fast}:1080p` : KREA_VEO_MODELS.fast;
  return { reference: { provider: KREA_UGC_PROVIDER, model: KREA_UGC_REFERENCE_MODEL }, video: { provider: KREA_UGC_PROVIDER, model: video } };
}
