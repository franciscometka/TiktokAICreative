import { SpeakerProfileSchema, type SpeakerProfile } from "@/domain/audio";

/**
 * Perfis de voz (pt-BR) e o mapeamento de cada um para a voz de cada provider.
 * O resto do sistema só conhece `SpeakerProfile.id`; o voiceId nunca sai do provider.
 *
 * As vozes abaixo são vozes PADRÃO (premade) da ElevenLabs, que falam português com os modelos
 * multilíngues. Para sotaque brasileiro nativo, troque o voiceId por uma voz pt-BR da Voice
 * Library (adicione à sua conta antes) — só esta tabela muda.
 */

export const SPEAKER_PROFILES: readonly SpeakerProfile[] = [
  {
    id: "clara",
    name: "Clara",
    description: "Feminina, calorosa e próxima — tom de recomendação",
    language: "pt-BR",
    gender: "feminine",
    age: "adult",
    tone: "warm",
  },
  {
    id: "bia",
    name: "Bia",
    description: "Feminina, jovem e animada — bom para gancho rápido",
    language: "pt-BR",
    gender: "feminine",
    age: "young",
    tone: "energetic",
  },
  {
    id: "rafael",
    name: "Rafael",
    description: "Masculina, confiante e clara — bom para demonstração",
    language: "pt-BR",
    gender: "masculine",
    age: "adult",
    tone: "confident",
  },
  {
    id: "lucas",
    name: "Lucas",
    description: "Masculina, jovem e casual — conversa entre amigos",
    language: "pt-BR",
    gender: "masculine",
    age: "young",
    tone: "casual",
  },
].map((p) => SpeakerProfileSchema.parse(p));

export const DEFAULT_SPEAKER_PROFILE_ID = "clara";

export interface ElevenLabsVoice {
  voiceId: string;
  /** Nome da voz na ElevenLabs (auditoria). */
  providerName: string;
  settings: { stability: number; similarityBoost: number; style: number; speed: number };
}

const DEFAULT_SETTINGS = { stability: 0.5, similarityBoost: 0.75, style: 0, speed: 1 } as const;

export const ELEVENLABS_VOICES: Readonly<Record<string, ElevenLabsVoice>> = {
  clara: { voiceId: "EXAVITQu4vr4xnSDxMaL", providerName: "Sarah", settings: DEFAULT_SETTINGS },
  bia: { voiceId: "cgSgspJ2msm6clMCkdW9", providerName: "Jessica", settings: { ...DEFAULT_SETTINGS, stability: 0.4 } },
  rafael: { voiceId: "nPczCjzI2devNBz1zQrb", providerName: "Brian", settings: DEFAULT_SETTINGS },
  lucas: { voiceId: "TX3LPaxmHKxFdv7VOQHJ", providerName: "Liam", settings: { ...DEFAULT_SETTINGS, stability: 0.45 } },
};

export class UnknownSpeakerProfileError extends Error {
  override name = "UnknownSpeakerProfileError";
}

export function getSpeakerProfile(id: string | undefined): SpeakerProfile {
  const wanted = id ?? DEFAULT_SPEAKER_PROFILE_ID;
  const profile = SPEAKER_PROFILES.find((p) => p.id === wanted);
  if (!profile) throw new UnknownSpeakerProfileError(`Perfil de voz desconhecido: ${wanted}`);
  return profile;
}

export function isKnownSpeakerProfile(id: string): boolean {
  return SPEAKER_PROFILES.some((p) => p.id === id);
}
