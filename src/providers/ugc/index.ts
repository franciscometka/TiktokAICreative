import type { ProviderPricing } from "@/domain/cost";
import type { ExecutionMode } from "@/domain/execution";
import type { UgcAudioStrategy } from "@/domain/ugc";
import { ProviderError } from "../types";
import { MockUgcReferenceProvider, MockUgcVideoProvider } from "./mock-ugc-providers";
import type { UgcReferenceProvider, UgcVideoProvider } from "./ugc-providers";

export interface UgcProviderFactories {
  reference: (pricing: ProviderPricing, mode: ExecutionMode) => UgcReferenceProvider;
  video: (pricing: ProviderPricing, mode: ExecutionMode) => UgcVideoProvider;
}

/**
 * Factories do AI UGC. MOCK sempre disponível; REAL recusa com erro claro (contrato Google
 * preparado em google-ugc-contract.ts, sem transporte). `mockAudioStrategy` permite exercitar as
 * duas estratégias de áudio offline.
 */
export function createUgcProviderFactories(options: { mockAudioStrategy?: UgcAudioStrategy } = {}): UgcProviderFactories {
  const unavailable = () => {
    throw new ProviderError("Provider AI UGC real ainda não configurado (contrato Google/Veo preparado, sem chamadas).");
  };
  return {
    reference: (pricing, mode) => (mode === "real" ? unavailable() : new MockUgcReferenceProvider(pricing)),
    video: (pricing, mode) => (mode === "real" ? unavailable() : new MockUgcVideoProvider(pricing, options.mockAudioStrategy ?? "native_speech")),
  };
}
