import { z } from "zod";

/**
 * Narração como ASSET independente (Lote 4): o mesmo áudio + timing serve ao Remotion hoje e,
 * no futuro, a lip sync, avatar apresentador ou vídeo generativo. Nada aqui conhece ElevenLabs
 * (o provider converte a resposta dele para estes tipos) nem o renderer.
 */

const nonEmpty = z.string().trim().min(1);
const seconds = z.number().nonnegative();

export const SPEECH_LANGUAGES = ["pt-BR"] as const;
export const SpeechLanguageSchema = z.enum(SPEECH_LANGUAGES);
export type SpeechLanguage = z.infer<typeof SpeechLanguageSchema>;

/**
 * Perfil de voz do PRODUTO (não do provider): nome amigável, idioma e caráter da voz.
 * O voiceId de cada provider fica fora daqui (config/voices.ts). No futuro um avatar UGC será
 * PresenterProfile (aparência) + SpeakerProfile (voz), sem mudar este tipo.
 */
export const SpeakerProfileSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{1,40}$/),
  name: nonEmpty,
  description: nonEmpty,
  language: SpeechLanguageSchema,
  gender: z.enum(["feminine", "masculine", "neutral"]),
  age: z.enum(["young", "adult", "mature"]),
  tone: z.enum(["warm", "energetic", "confident", "casual", "calm"]),
});
export type SpeakerProfile = z.infer<typeof SpeakerProfileSchema>;

/**
 * Timing por caractere do texto ENVIADO ao TTS (forma interna; cada provider converte a sua).
 * characters[i] dura de startSeconds[i] a endSeconds[i].
 */
export const CharacterTimingSchema = z
  .object({
    characters: z.array(z.string()),
    startSeconds: z.array(seconds),
    endSeconds: z.array(seconds),
  })
  .refine((t) => t.characters.length === t.startSeconds.length && t.characters.length === t.endSeconds.length, {
    message: "Alinhamento com tamanhos diferentes",
  });
export type CharacterTiming = z.infer<typeof CharacterTimingSchema>;

/** Uma palavra ESCRITA (como aparece na legenda) com o tempo real em que foi falada. */
export const TimedWordSchema = z.object({
  text: nonEmpty,
  startSeconds: seconds,
  endSeconds: seconds,
  sceneId: z.string().nullable(),
});
export type TimedWord = z.infer<typeof TimedWordSchema>;

/** Trecho de legenda com timing real (mesmo formato de legenda do manifest). */
export const TimedCaptionSchema = z.object({
  text: nonEmpty,
  startSeconds: seconds,
  endSeconds: seconds,
});
export type TimedCaption = z.infer<typeof TimedCaptionSchema>;

/** Janela de fala de cada cena dentro da narração contínua (útil para lip sync/avatar). */
export const SceneSpeechWindowSchema = z.object({
  sceneId: nonEmpty,
  startSeconds: seconds,
  endSeconds: seconds,
});
export type SceneSpeechWindow = z.infer<typeof SceneSpeechWindowSchema>;

export const NarrationTimingSchema = z.object({
  source: z.literal("alignment"),
  words: z.array(TimedWordSchema),
  scenes: z.array(SceneSpeechWindowSchema),
  /** Fim da última palavra falada (s). Pode ser menor que a duração do arquivo (silêncio final). */
  speechEndSeconds: seconds,
});
export type NarrationTiming = z.infer<typeof NarrationTimingSchema>;

export const AUDIO_FIT_STATUSES = ["fits", "too_short", "too_long"] as const;
export const AudioFitStatusSchema = z.enum(AUDIO_FIT_STATUSES);
export type AudioFitStatus = z.infer<typeof AudioFitStatusSchema>;

/**
 * Comparação entre a duração planejada do criativo e a fala real.
 * action: "none" (cabe), "extend" (excede pouco: o fim do vídeo é estendido localmente, sem
 * cortar fala) ou "review" (excede muito: exige decisão explícita do usuário).
 */
export const AudioFitSchema = z.object({
  targetDuration: z.number().positive(),
  actualDuration: seconds,
  difference: z.number(),
  status: AudioFitStatusSchema,
  action: z.enum(["none", "extend", "review"]),
  /** Segundos acrescentados ao fim do vídeo para a fala caber (0 se não precisar). */
  extendSeconds: seconds,
  /** true quando a duração vem de áudio real; mock nunca bloqueia o fluxo. */
  measured: z.boolean(),
});
export type AudioFit = z.infer<typeof AudioFitSchema>;

/** Dados da narração guardados na tentativa de áudio (sem bytes, sem caminho absoluto). */
export const NarrationInfoSchema = z.object({
  speakerProfileId: nonEmpty,
  /** voiceId do provider (só para auditoria; nunca usado pela UI para decidir nada). */
  voiceId: z.string().optional(),
  language: SpeechLanguageSchema,
  requestId: z.string().optional(),
  /** Caracteres enviados ao TTS (texto falado, já normalizado). Base do custo monetário. */
  inputCharacters: z.int().nonnegative(),
  /**
   * Consumo BRUTO informado pelo provider (ElevenLabs: header `character-cost`, créditos/quota).
   * Outra unidade: não é caractere cobrado nem dinheiro; nunca entra no cálculo de custo.
   */
  providerCharacterCost: z.int().nonnegative().optional(),
  /** Versão no disco (ex.: "v2"). Ausente no mock. */
  version: z.string().optional(),
  timingUri: z.string().optional(),
  captionTiming: z.enum(["alignment", "estimated"]),
  speechEndSeconds: seconds.optional(),
  fit: AudioFitSchema.optional(),
  /** Quando o usuário aceitou explicitamente uma narração que pedia revisão (fit.action = review). */
  reviewAcceptedAt: z.string().optional(),
  /** Aviso não fatal (ex.: alinhamento inconsistente → legendas estimadas). */
  note: z.string().optional(),
});
export type NarrationInfo = z.infer<typeof NarrationInfoSchema>;
