import type { PresetQuality } from "./quality-presets";

/**
 * ÚNICO lugar com IDs de modelo de TTS (como llm-models.ts para o Claude).
 * Preços em config/pricing.ts; vozes em config/voices.ts.
 */

export const ELEVENLABS_PROVIDER = "elevenlabs";

export const ELEVENLABS_MODELS = {
  flash: "eleven_flash_v2_5",
  multilingual: "eleven_multilingual_v2",
} as const;
export type ElevenLabsModelId = (typeof ELEVENLABS_MODELS)[keyof typeof ELEVENLABS_MODELS];

export interface TtsModelCapabilities {
  /** Aceita `language_code` na requisição (o multilingual_v2 detecta o idioma pelo texto). */
  acceptsLanguageCode: boolean;
  /** Máximo de caracteres por requisição aceito pelo modelo. */
  maxCharacters: number;
}

export const ELEVENLABS_MODEL_CAPABILITIES: Record<ElevenLabsModelId, TtsModelCapabilities> = {
  [ELEVENLABS_MODELS.flash]: { acceptsLanguageCode: true, maxCharacters: 40_000 },
  [ELEVENLABS_MODELS.multilingual]: { acceptsLanguageCode: false, maxCharacters: 10_000 },
};

/** Modelo de narração por preset. Trocar = uma linha aqui (+ preço em pricing.ts). */
export const NARRATION_TTS: Record<PresetQuality, { provider: string; model: ElevenLabsModelId }> = {
  economy: { provider: ELEVENLABS_PROVIDER, model: ELEVENLABS_MODELS.flash },
  high: { provider: ELEVENLABS_PROVIDER, model: ELEVENLABS_MODELS.multilingual },
  premium: { provider: ELEVENLABS_PROVIDER, model: ELEVENLABS_MODELS.multilingual },
};

/** Código ISO 639-1 enviado ao ElevenLabs para cada idioma interno. */
export const ELEVENLABS_LANGUAGE_CODES = { "pt-BR": "pt" } as const;

/** Formato pedido: MP3 44,1 kHz 128 kbps (disponível em todos os planos). */
export const ELEVENLABS_OUTPUT_FORMAT = "mp3_44100_128";

/** Limite de segurança do NOSSO lado por narração (um criativo tem ~300–700 caracteres). */
export const MAX_NARRATION_CHARACTERS = 2_500;
