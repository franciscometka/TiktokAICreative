import type { AppConfig } from "@/config/env";
import type { ProviderPricing } from "@/domain/cost";
import { RunwayVideoProvider } from "./runway-video-provider";
import { MockVideoProvider } from "./mock-video-provider";
import type { VideoProvider } from "./video-provider";

export type VideoProviderFactory = (pricing: ProviderPricing) => VideoProvider;

/**
 * Escolhe a implementação a partir da configuração. Novos providers (Veo, Runway, Kling)
 * entram aqui como novos `case`, sem mudar domínio nem pipeline.
 */
export function createVideoProviderFactory(providerId: AppConfig["videoProvider"], options?: { apiKey?: string; uploadsDir: string }): VideoProviderFactory {
  switch (providerId) {
    case "runway":
      return (pricing) => new RunwayVideoProvider({ pricing, apiKey: options?.apiKey ?? "", uploadsDir: options?.uploadsDir ?? "outputs/uploads" });
    case "mock":
      return (pricing) => new MockVideoProvider({ pricing });
  }
}
