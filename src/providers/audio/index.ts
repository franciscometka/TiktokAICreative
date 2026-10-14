import type { AppConfig } from "@/config/env";
import { ELEVENLABS_VOICES } from "@/config/voices";
import type { ProviderPricing } from "@/domain/cost";
import { ProviderError } from "../types";
import type { AudioProvider } from "./audio-provider";
import { ElevenLabsAudioProvider, type HttpTransport } from "./elevenlabs-audio-provider";
import { MockAudioProvider } from "./mock-audio-provider";

export type AudioProviderFactory = (pricing: ProviderPricing) => AudioProvider;

export interface AudioProviderSettings {
  /** Lida do ambiente pela raiz de composição; nunca vem do browser. */
  elevenLabsApiKey?: string;
  ttsTimeoutMs: number;
  transport?: HttpTransport;
}

/**
 * Factory de áudio (AUDIO_PROVIDER=mock|elevenlabs). O preço do tier vem do preset; o mock
 * simula o MESMO preço (D7). ElevenLabs sem chave falha na geração com erro claro — antes de
 * qualquer chamada — e o resto do app continua funcionando.
 */
export function createAudioProviderFactory(
  providerId: AppConfig["audioProvider"],
  settings: AudioProviderSettings = { ttsTimeoutMs: 60_000 },
): AudioProviderFactory {
  switch (providerId) {
    case "mock":
      return (pricing) => new MockAudioProvider({ pricing });
    case "elevenlabs":
      return (pricing) => {
        if (!settings.elevenLabsApiKey) throw new ProviderError("ELEVENLABS_API_KEY não está definida (AUDIO_PROVIDER=elevenlabs)");
        return new ElevenLabsAudioProvider({
          pricing,
          apiKey: settings.elevenLabsApiKey,
          voices: ELEVENLABS_VOICES,
          timeoutMs: settings.ttsTimeoutMs,
          transport: settings.transport,
        });
      };
  }
}
