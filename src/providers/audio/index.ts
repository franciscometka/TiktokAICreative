import type { AppConfig } from "@/config/env";
import type { ProviderPricing } from "@/domain/cost";
import type { AudioProvider } from "./audio-provider";
import { MockAudioProvider } from "./mock-audio-provider";

export type AudioProviderFactory = (pricing: ProviderPricing) => AudioProvider;

/** Novos providers (ex.: ElevenLabs) entram aqui como novos `case`. */
export function createAudioProviderFactory(providerId: AppConfig["audioProvider"]): AudioProviderFactory {
  switch (providerId) {
    case "mock":
      return (pricing) => new MockAudioProvider({ pricing });
  }
}
