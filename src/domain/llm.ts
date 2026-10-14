import { z } from "zod";
import { CostOperationSchema } from "./cost";

const nonEmpty = z.string().trim().min(1);
const tokens = z.int().nonnegative();

/** Uso de tokens exatamente como reportado pela API (ou simulado por mock). */
export const TokenUsageSchema = z.object({
  inputTokens: tokens,
  outputTokens: tokens,
  cacheCreationInputTokens: tokens,
  cacheReadInputTokens: tokens,
});
export type TokenUsage = z.infer<typeof TokenUsageSchema>;

export const LLM_CALL_OUTCOMES = [
  "valid",
  "invalid_json",
  "schema_mismatch",
  "empty_response",
  "max_tokens",
  "refusal",
  "provider_error",
] as const;
export const LlmCallOutcomeSchema = z.enum(LLM_CALL_OUTCOMES);
export type LlmCallOutcome = z.infer<typeof LlmCallOutcomeSchema>;

/**
 * Registro de auditoria de UMA chamada a um LLM (inclusive tentativas inválidas).
 * O dinheiro em si fica no ledger (GenerationCost com llmCallId); este registro guarda o contexto.
 */
export const LlmCallRecordSchema = z.object({
  id: nonEmpty,
  campaignId: nonEmpty,
  operation: CostOperationSchema,
  promptId: nonEmpty,
  promptVersion: nonEmpty,
  provider: nonEmpty,
  requestedModel: nonEmpty,
  /** Modelo que efetivamente respondeu (vem da resposta da API). */
  servedModel: nonEmpty,
  requestId: z.string().nullable(),
  attempt: z.int().positive(),
  usage: TokenUsageSchema,
  stopReason: z.string().nullable(),
  outcome: LlmCallOutcomeSchema,
  /** Resumo do erro de validação/provider. Nunca contém a API key. */
  errorSummary: z.string().optional(),
  durationMs: z.number().nonnegative(),
  costUsd: z.number().nonnegative(),
  costBrl: z.number().nonnegative(),
  exchangeRate: z.number().positive(),
  simulated: z.boolean(),
  createdAt: nonEmpty,
});
export type LlmCallRecord = z.infer<typeof LlmCallRecordSchema>;
