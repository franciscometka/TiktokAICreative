import { z } from "zod";

/**
 * Lote 6 — Voice Lock. Como a fala chega aos A-rolls:
 *   - native: o modelo de vídeo gera fala + áudio de cada trecho (Veo/Krea hoje). A voz pode
 *     variar entre trechos; mitigação = mesma descrição de voz no prompt de todos os trechos.
 *   - external_lipsync: UMA narração contínua (master audio, ElevenLabs) com a voz fixa do avatar;
 *     o áudio é dividido logicamente e um provider de vídeo/lip-sync sincroniza cada trecho.
 * LOCKED_VOICE só existe quando o provider instalado REALMENTE aceita áudio externo + lip-sync.
 * Nunca há fallback silencioso: a decisão (e o motivo) fica registrada no projeto.
 */

export const VideoSpeechStrategySchema = z.enum(["native", "external_lipsync"]);
export type VideoSpeechStrategy = z.infer<typeof VideoSpeechStrategySchema>;

/** Matriz de capacidades DECLARADA por provider (nada presumido). */
export const SpeechCapabilitiesSchema = z.object({
  supportsNativeAudio: z.boolean(),
  supportsExternalAudio: z.boolean(),
  supportsLipSync: z.boolean(),
  supportsIdentityReference: z.boolean(),
  supportsProductReference: z.boolean(),
});
export type SpeechCapabilities = z.infer<typeof SpeechCapabilitiesSchema>;

/** Pedido do usuário: auto (Voice Lock quando possível), locked (exige) ou native (fala do vídeo). */
export const VoiceLockRequestSchema = z.enum(["auto", "locked", "native"]);
export type VoiceLockRequest = z.infer<typeof VoiceLockRequestSchema>;

export const VOICE_LOCK_UNAVAILABLE = "Voice Lock indisponível com este provider.";

export const VoiceLockDecisionSchema = z.object({
  requested: VoiceLockRequestSchema,
  strategy: z.enum(["locked_voice", "provider_native"]),
  speech: VideoSpeechStrategySchema,
  /** O provider instalado suporta LOCKED_VOICE de verdade? */
  available: z.boolean(),
  provider: z.string(),
  /** Motivo visível (sempre presente quando não é LOCKED_VOICE). */
  reason: z.string(),
  voiceProfileId: z.string().optional(),
});
export type VoiceLockDecision = z.infer<typeof VoiceLockDecisionSchema>;

export class VoiceLockUnavailableError extends Error {
  override name = "VoiceLockUnavailableError";
}

export function supportsVoiceLock(caps: SpeechCapabilities): boolean {
  return caps.supportsExternalAudio && caps.supportsLipSync;
}

/**
 * Decide a estratégia. "locked" sem suporte real → erro explícito (nunca troca sozinho).
 * "auto" sem suporte → provider_native COM motivo registrado e exibido.
 */
export function resolveVoiceLock(input: { requested: VoiceLockRequest; provider: string; capabilities: SpeechCapabilities; voiceProfileId?: string }): VoiceLockDecision {
  const available = supportsVoiceLock(input.capabilities);
  const base = { requested: input.requested, available, provider: input.provider, ...(input.voiceProfileId ? { voiceProfileId: input.voiceProfileId } : {}) };
  if (input.requested === "locked" && !available) throw new VoiceLockUnavailableError(`${VOICE_LOCK_UNAVAILABLE} O provider "${input.provider}" não aceita áudio externo com lip-sync; escolha "Voz do próprio vídeo" para continuar.`);
  if (input.requested !== "native" && available) {
    return { ...base, strategy: "locked_voice", speech: "external_lipsync", reason: "Voice Lock: uma narração contínua com a voz fixa do avatar, sincronizada em cada trecho." };
  }
  if (!input.capabilities.supportsNativeAudio) throw new VoiceLockUnavailableError(`O provider "${input.provider}" não gera fala nativa nem aceita áudio externo: nenhuma estratégia de voz disponível.`);
  return {
    ...base, strategy: "provider_native", speech: "native",
    reason: input.requested === "native" ? "Voz do próprio vídeo (escolhida)." : `${VOICE_LOCK_UNAVAILABLE} Usando a fala nativa do vídeo; a mesma descrição de voz vai em todos os trechos.`,
  };
}

/** Áudio mestre do vídeo inteiro (uma narração contínua). */
export const MasterAudioAssetSchema = z.object({
  narrationVersion: z.string(),
  uri: z.string(),
  durationSeconds: z.number().positive(),
  provider: z.string(),
  model: z.string(),
  voiceProfileId: z.string().optional(),
  /** Palavras com tempo (alignment do provider), quando disponível. */
  words: z.array(z.object({ text: z.string(), startSeconds: z.number(), endSeconds: z.number() })).optional(),
  segments: z.array(z.object({ index: z.int().nonnegative(), sceneId: z.string(), startSeconds: z.number(), endSeconds: z.number() })),
});
export type MasterAudioAsset = z.infer<typeof MasterAudioAssetSchema>;

/**
 * Divide LOGICAMENTE o áudio mestre pelos segmentos do master script. Com alignment, o corte cai
 * no meio da pausa entre a última palavra de um segmento e a primeira do seguinte; sem alignment,
 * proporcional ao número de palavras. Intervalos contíguos, cobrindo 0 → duração.
 */
export function masterAudioSegments(input: {
  durationSeconds: number;
  segmentWordCounts: readonly number[];
  sceneIds: readonly string[];
  words?: readonly { startSeconds: number; endSeconds: number }[];
}): MasterAudioAsset["segments"] {
  const total = input.segmentWordCounts.reduce((a, b) => a + b, 0);
  if (total === 0 || input.segmentWordCounts.length !== input.sceneIds.length) throw new Error("Segmentos do master script inválidos para dividir o áudio.");
  const cuts: number[] = [0];
  let cursor = 0;
  for (let i = 0; i < input.segmentWordCounts.length - 1; i++) {
    cursor += input.segmentWordCounts[i]!;
    const words = input.words;
    if (words && words.length >= total) {
      const lastEnd = words[cursor - 1]!.endSeconds;
      const nextStart = words[cursor]!.startSeconds;
      cuts.push(Math.round(((lastEnd + nextStart) / 2) * 1000) / 1000);
    } else {
      cuts.push(Math.round(((input.durationSeconds * cursor) / total) * 1000) / 1000);
    }
  }
  cuts.push(input.durationSeconds);
  return input.sceneIds.map((sceneId, index) => ({ index, sceneId, startSeconds: cuts[index]!, endSeconds: cuts[index + 1]! }));
}
