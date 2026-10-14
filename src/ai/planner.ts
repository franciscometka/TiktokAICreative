import type { CampaignPlan } from "@/domain/campaign";
import type { CreativeStyle } from "@/domain/creative";
import type { ProductInput } from "@/domain/product";
import type { QualitySettings } from "@/domain/quality";
import type { LlmCallAttempt } from "./structured-output";

export interface PlanningRequest {
  product: ProductInput;
  styles: readonly CreativeStyle[];
  creativeCount: number;
  settings: QualitySettings;
}

export interface PlanningResult {
  plan: CampaignPlan;
  /** TODAS as chamadas feitas (inclusive tentativas inválidas) — base do custo real. */
  calls: LlmCallAttempt[];
  plannerId: string;
  provider: string;
  promptId: string;
  promptVersion: string;
  /** true = plano gerado por mock, sem chamada real. */
  simulated: boolean;
}

/** Parâmetros do pior caso de custo, para checar orçamento ANTES de chamar. */
export interface PlanningWorstCase {
  estimatedInputTokens: number;
  maxOutputTokens: number;
  maxAttempts: number;
}

export type PlanningErrorKind = "retry_exhausted" | "stopped" | "provider_error" | "invalid_plan";

const MESSAGES: Record<PlanningErrorKind, string> = {
  retry_exhausted: "O Claude não produziu um plano válido dentro do limite de tentativas",
  stopped: "A geração do plano foi interrompida (limite de tokens ou recusa)",
  provider_error: "Falha ao chamar o provedor do LLM",
  invalid_plan: "O plano retornado violou regras de domínio",
};

export class PlanningError extends Error {
  override name = "PlanningError";
  constructor(
    readonly kind: PlanningErrorKind,
    detail: string,
    /** Chamadas feitas antes da falha — precisam ser contabilizadas. */
    readonly calls: LlmCallAttempt[],
    readonly meta: { provider: string; promptId: string; promptVersion: string; simulated: boolean },
  ) {
    super(`${MESSAGES[kind]}: ${detail}`);
  }
}

/**
 * Produto → CampaignPlan. Implementações: LlmCreativePlanner (Claude) e MockCreativePlanner.
 */
export interface CreativePlanner {
  readonly id: string;
  worstCase(request: PlanningRequest): PlanningWorstCase;
  plan(request: PlanningRequest): Promise<PlanningResult>;
}
