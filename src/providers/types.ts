import type { ProviderPricing } from "@/domain/cost";
import type { Usage } from "@/costs/calculate";

/** Identidade de um provider concreto + o preço que ele cobra. */
export interface ProviderDescriptor {
  id: string;
  model: string;
  /** true = não chama nenhum serviço externo nem gasta dinheiro. */
  isMock: boolean;
  pricing: ProviderPricing;
}

export interface ProviderJobRef {
  providerJobId: string;
}

export type ProviderJobState = "queued" | "running" | "succeeded" | "failed";

export interface ProviderJobStatus {
  providerJobId: string;
  state: ProviderJobState;
  error?: string;
  /** Consumo faturado mesmo em falha (alguns providers cobram tentativas falhas). */
  billedUsage?: Usage;
}

export interface MediaResult {
  uri: string;
  mimeType: string;
  durationSeconds: number;
  /** Consumo efetivamente faturado — base do custo REAL. */
  billedUsage: Usage;
  isMock: boolean;
}

/** Cotação de uma chamada antes de executá-la. Sempre uma ESTIMATIVA. */
export interface CostQuote {
  kind: "estimate";
  quantity: number;
  costUsd: number;
  pricing: ProviderPricing;
}

export class ProviderError extends Error {
  override name = "ProviderError";
  constructor(
    message: string,
    readonly providerJobId?: string,
    readonly billedUsage?: Usage,
  ) {
    super(message);
  }
}
