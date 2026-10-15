import type { ClipDurationCheck } from "@/domain/media-integrity";
import type { ProviderDiagnostic } from "@/domain/provider-diagnostic";
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
  diagnostic?: ProviderDiagnostic;
  /** Consumo faturado mesmo em falha (alguns providers cobram tentativas falhas). */
  billedUsage?: Usage;
}

export interface MediaResult {
  data?: Uint8Array;
  uri: string;
  mimeType: string;
  durationSeconds: number;
  /** Duração PEDIDA ao provider (a que é cobrada). Vídeo real (Lote 5). */
  requestedDurationSeconds?: number;
  /** Duração que o provider informou, se informou (Runway não informa). Nunca substitui a medida. */
  providerReportedDurationSeconds?: number;
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

/**
 * Clipe gerado (e cobrado) mas REJEITADO pela checagem de integridade. O custo já foi registrado
 * antes; não carrega billedUsage para não registrar de novo. Nunca é re-tentado.
 */
export class InvalidMediaError extends Error {
  override name = "InvalidMediaError";
  constructor(
    message: string,
    readonly media: ClipDurationCheck,
    readonly rejectedAssetUri?: string,
  ) {
    super(message);
  }
}

export class ProviderError extends Error {
  override name = "ProviderError";
  constructor(
    message: string,
    readonly providerJobId?: string,
    readonly billedUsage?: Usage,
    readonly diagnostic?: ProviderDiagnostic,
  ) {
    super(message);
  }
}
