import type { GoogleUgcReadiness } from "@/config/ugc-readiness";
import { GOOGLE_UGC_PROVIDER } from "@/config/ugc-models";
import type { ProviderPricing } from "@/domain/cost";
import type { ExecutionMode } from "@/domain/execution";
import type { UgcAudioStrategy } from "@/domain/ugc";
import { ProviderError } from "../types";
import { GoogleAiHttpClient } from "./google-http";
import { UgcReferenceProviderGoogle, UgcVideoProviderVeo } from "./google-ugc-providers";
import { GeminiReferenceTransport, VeoVideoTransport, type GoogleImageLoader } from "./google-transports";
import { MockUgcReferenceProvider, MockUgcVideoProvider } from "./mock-ugc-providers";
import type { UgcReferenceProvider, UgcVideoProvider } from "./ugc-providers";

export interface UgcProviderFactories {
  reference: (pricing: ProviderPricing, mode: ExecutionMode) => UgcReferenceProvider;
  video: (pricing: ProviderPricing, mode: ExecutionMode) => UgcVideoProvider;
}

/** Runtime Google (servidor). A chave fica só aqui, dentro do cliente HTTP. */
export interface GoogleUgcRuntime {
  apiKey?: string;
  readiness: GoogleUgcReadiness;
  loadImage: GoogleImageLoader;
  /** Transporte injetado (testes/scripts). Ausente = fetch global, protegido pela autorização efêmera. */
  transport?: typeof fetch;
}

/**
 * Factories do AI UGC. MOCK sempre disponível. REAL (Lote 5.4) só quando o preflight Google passa
 * inteiro (chave + UGC_PROVIDER=google + modelos + UGC_REAL_ALLOWED=true); caso contrário recusa
 * com o motivo, sem rede. `mockAudioStrategy` exercita as duas estratégias de áudio offline.
 */
export function createUgcProviderFactories(options: { mockAudioStrategy?: UgcAudioStrategy; google?: GoogleUgcRuntime } = {}): UgcProviderFactories {
  const http = (pricing: ProviderPricing) => {
    const google = options.google;
    if (!google?.readiness.ready || !google.apiKey) {
      throw new ProviderError(google?.readiness.reason ?? "Provider AI UGC real ainda não configurado (Google desligado por padrão).");
    }
    if (pricing.provider !== GOOGLE_UGC_PROVIDER) throw new ProviderError("O plano usa outro provider AI UGC; crie um novo projeto e aprove a nova estimativa.");
    return { client: new GoogleAiHttpClient(google.apiKey, google.transport), loadImage: google.loadImage };
  };
  return {
    reference: (pricing, mode) => {
      if (mode !== "real") return new MockUgcReferenceProvider(pricing);
      const { client, loadImage } = http(pricing);
      return new UgcReferenceProviderGoogle(pricing, new GeminiReferenceTransport(client, loadImage));
    },
    video: (pricing, mode) => {
      if (mode !== "real") return new MockUgcVideoProvider(pricing, options.mockAudioStrategy ?? "native_speech");
      const { client, loadImage } = http(pricing);
      return new UgcVideoProviderVeo(pricing, new VeoVideoTransport(client, loadImage));
    },
  };
}

export { UgcReferenceProviderGoogle, UgcVideoProviderVeo } from "./google-ugc-providers";
export type { GoogleUgcReferenceTransport, VeoUgcVideoTransport } from "./google-ugc-providers";
export { GoogleAiHttpClient, GoogleUgcError } from "./google-http";
export { GeminiReferenceTransport, VeoVideoTransport, localImageLoader } from "./google-transports";
