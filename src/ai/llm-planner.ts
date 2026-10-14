import type { IdGenerator } from "@/lib/ids";
import { hydrateCampaignPlan } from "./hydrate";
import type { LlmClient } from "./llm-client";
import type { CampaignPlanPromptInput } from "./prompts/campaign-plan.v1";
import { ACTIVE_PROMPTS } from "./prompts/registry";
import type { PromptDefinition } from "./prompts/types";
import {
  PlanningError,
  type CreativePlanner,
  type PlanningRequest,
  type PlanningResult,
  type PlanningWorstCase,
} from "./planner";
import { describeError, runStructuredPrompt } from "./structured-output";
import type { CampaignPlanDraft } from "@/domain/campaign";

/** Aproximação conservadora para estimar tokens de entrada antes da chamada (pt-BR + JSON). */
const CHARS_PER_TOKEN_ESTIMATE = 3;

/**
 * Planner com LLM real: prompt versionado → saída estruturada → Zod → hydrate (IDs internos).
 * Avaliação contra o preset e ajustes ficam no pipeline (costs/plan-evaluation.ts).
 */
export class LlmCreativePlanner implements CreativePlanner {
  readonly id: string;

  constructor(
    private readonly llm: LlmClient,
    private readonly ids: IdGenerator,
    private readonly policy: { maxValidationAttempts: number },
    private readonly prompt: PromptDefinition<CampaignPlanPromptInput, CampaignPlanDraft> = ACTIVE_PROMPTS.campaignPlan,
  ) {
    this.id = llm.provider;
  }

  worstCase(request: PlanningRequest): PlanningWorstCase {
    const chars = this.prompt.system.length + this.prompt.buildUserMessage(request).length;
    return {
      // Retries reenviam a resposta anterior como referência: dobra a entrada no pior caso.
      estimatedInputTokens: Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE) * 2,
      maxOutputTokens: this.prompt.maxTokensFor(request),
      maxAttempts: this.policy.maxValidationAttempts,
    };
  }

  async plan(request: PlanningRequest): Promise<PlanningResult> {
    const meta = {
      provider: this.llm.provider,
      promptId: this.prompt.id,
      promptVersion: this.prompt.version,
      simulated: this.llm.isMock,
    };
    const result = await runStructuredPrompt(this.llm, this.prompt, request, {
      model: request.settings.llm.model,
      effort: request.settings.llm.effort,
      maxAttempts: this.policy.maxValidationAttempts,
    });

    if (!result.ok) {
      const failure = result.error;
      switch (failure.kind) {
        case "retry_exhausted":
          throw new PlanningError("retry_exhausted", describeError(failure.lastError), failure.calls, meta);
        case "stopped":
          throw new PlanningError("stopped", failure.stopReason, failure.calls, meta);
        case "provider_error":
          throw new PlanningError("provider_error", failure.message, failure.calls, meta, failure.llmErrorKind);
      }
    }

    const { data, calls } = result.value;
    let plan;
    try {
      plan = hydrateCampaignPlan(data, request.product, this.ids);
    } catch (error) {
      throw new PlanningError("invalid_plan", error instanceof Error ? error.message : String(error), calls, meta);
    }
    return { plan, calls, plannerId: this.id, ...meta };
  }
}
