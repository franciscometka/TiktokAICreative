import type { LlmError } from "./llm-client";
import { PlanningUnavailableError, type CreativePlanner, type PlanningResult, type PlanningWorstCase } from "./planner";

/**
 * Planner usado quando o LLM configurado não pode ser criado (ex.: LLM_PROVIDER=anthropic sem
 * ANTHROPIC_API_KEY). O app continua abrindo campanhas existentes; criar uma nova é recusado
 * ANTES de qualquer escrita ou chamada.
 */
export class UnavailablePlanner implements CreativePlanner {
  readonly unavailable: { kind: LlmError["kind"]; message: string };

  constructor(
    readonly id: string,
    error: LlmError,
  ) {
    this.unavailable = { kind: error.kind, message: error.message };
  }

  worstCase(): PlanningWorstCase {
    return { estimatedInputTokens: 0, maxOutputTokens: 0, maxAttempts: 0 };
  }

  async plan(): Promise<PlanningResult> {
    throw new PlanningUnavailableError(this.unavailable.kind, this.unavailable.message);
  }
}
