/**
 * Política de encaixe da narração real na duração planejada (AudioFit, speech/audio-fit.ts).
 * - |diferença| ≤ toleranceSeconds → "fits".
 * - Fala mais longa até max(extendMaxSeconds, extendMaxRatio × duração) → estende o fim do vídeo
 *   localmente (nunca corta fala, nenhuma chamada nova).
 * - Mais longa que isso → "review": o usuário decide (aceitar vídeo mais longo, gerar a narração
 *   de novo — paga, nova versão — ou cancelar). Nunca há regeneração paga automática.
 */
export const AUDIO_FIT_POLICY = {
  toleranceSeconds: 0.5,
  extendMaxSeconds: 2,
  extendMaxRatio: 0.1,
  /** Respiro depois da última palavra antes do fim do vídeo. */
  tailSeconds: 0.4,
} as const;
