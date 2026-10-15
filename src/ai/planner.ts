import type { CampaignPlan } from "@/domain/campaign";
import type { CreativeStyle } from "@/domain/creative";
import type { ProductInput } from "@/domain/product";
import type { QualitySettings } from "@/domain/quality";
import type { LlmErrorKind } from "./llm-client";
import type { LlmCallAttempt } from "./structured-output";

export interface PlanningRequest {
  product: ProductInput;
  styles: readonly CreativeStyle[];
  creativeCount: number;
  presenterPresetId?: string;
  projectName?: string;
  videoConcept?: string;
  scriptMode?: "manual" | "generate";
  script?: string;
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
    /** Quando kind = "provider_error": o tipo do erro do LLM (rate limit, timeout...). */
    readonly llmErrorKind?: LlmErrorKind,
  ) {
    super(`${MESSAGES[kind]}: ${detail}`);
  }
}

/** O planner não pode ser usado (ex.: ANTHROPIC_API_KEY ausente). Nada é criado nem chamado. */
export class PlanningUnavailableError extends Error {
  override name = "PlanningUnavailableError";
  constructor(
    readonly llmErrorKind: LlmErrorKind,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Produto → CampaignPlan. Implementações: LlmCreativePlanner (Claude) e MockCreativePlanner.
 */
export interface CreativePlanner {
  readonly id: string;
  /** Presente quando o planner não pode ser usado; o pipeline recusa antes de criar a campanha. */
  readonly unavailable?: { kind: LlmErrorKind; message: string };
  worstCase(request: PlanningRequest): PlanningWorstCase;
  plan(request: PlanningRequest): Promise<PlanningResult>;
}
