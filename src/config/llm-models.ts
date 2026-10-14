import type { LlmChoice } from "@/domain/quality";

/**
 * ÚNICO lugar com IDs de modelos Claude. Nenhum outro arquivo deve conter "claude-...".
 * Preços correspondentes ficam em config/pricing.ts.
 */
export const ANTHROPIC_PROVIDER = "anthropic";

export const CLAUDE_MODELS = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
} as const;
export type ClaudeModelId = (typeof CLAUDE_MODELS)[keyof typeof CLAUDE_MODELS];

/** Modelo de planejamento por preset (referenciado em quality-presets.ts). */
export const PLANNING_LLM = {
  economy: { provider: ANTHROPIC_PROVIDER, model: CLAUDE_MODELS.sonnet, effort: "medium" },
  high: { provider: ANTHROPIC_PROVIDER, model: CLAUDE_MODELS.sonnet, effort: "high" },
  premium: { provider: ANTHROPIC_PROVIDER, model: CLAUDE_MODELS.opus, effort: "high" },
} as const satisfies Record<"economy" | "high" | "premium", LlmChoice>;

/**
 * Reservado para tarefas auxiliares de grande volume (ex.: variações de legenda, classificação).
 * Ainda não usado — não há roteamento de modelos nesta fase.
 */
export const AUXILIARY_LLM = {
  provider: ANTHROPIC_PROVIDER,
  model: CLAUDE_MODELS.haiku,
  effort: "low",
} as const satisfies LlmChoice;

/** Limite de tokens de saída do planejamento (inclui raciocínio do modelo). */
export const CAMPAIGN_PLAN_TOKEN_LIMITS = {
  base: 8_000,
  perCreative: 6_000,
  cap: 64_000,
} as const;

export function campaignPlanMaxTokens(creativeCount: number): number {
  const { base, perCreative, cap } = CAMPAIGN_PLAN_TOKEN_LIMITS;
  return Math.min(cap, base + perCreative * creativeCount);
}
