import type { z } from "zod";
import type { LlmCallOutcome, TokenUsage } from "@/domain/llm";
import type { LlmEffort } from "@/domain/quality";
import { err, ok, type Result } from "@/lib/result";
import { LlmError, ZERO_USAGE, type LlmClient, type LlmErrorKind } from "./llm-client";
import type { PromptDefinition } from "./prompts/types";

/**
 * Validação de saídas estruturadas do LLM.
 * Fluxo: resposta → JSON.parse → Zod → (sucesso | erro tipado).
 * NUNCA "consertar" JSON com regex. NUNCA aceitar resposta inválida em silêncio.
 */

export interface ValidationIssue {
  path: string;
  message: string;
}

export type StructuredOutputError =
  | { kind: "empty_response" }
  | { kind: "invalid_json"; message: string }
  | { kind: "schema_mismatch"; issues: ValidationIssue[] };

export function parseStructuredOutput<T>(text: string, schema: z.ZodType<T>): Result<T, StructuredOutputError> {
  if (text.trim() === "") return err({ kind: "empty_response" });
  let json: unknown;
  try {
    json = JSON.parse(text.trim());
  } catch (e) {
    return err({ kind: "invalid_json", message: e instanceof Error ? e.message : String(e) });
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return err({
      kind: "schema_mismatch",
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return ok(parsed.data);
}

export function describeError(error: StructuredOutputError): string {
  switch (error.kind) {
    case "empty_response":
      return "A resposta veio vazia.";
    case "invalid_json":
      return `A resposta não é JSON válido: ${error.message}`;
    case "schema_mismatch":
      return `A resposta não segue as regras do schema:\n${error.issues
        .slice(0, 20)
        .map((i) => `- ${i.path || "(raiz)"}: ${i.message}`)
        .join("\n")}`;
  }
}

/** Metadados de UMA chamada (válida ou não). Toda chamada é contabilizada. */
export interface LlmCallAttempt {
  attempt: number;
  requestedModel: string;
  servedModel: string;
  requestId: string | null;
  usage: TokenUsage;
  stopReason: string | null;
  outcome: LlmCallOutcome;
  errorSummary?: string;
  durationMs: number;
}

export type StructuredPromptFailure =
  | { kind: "retry_exhausted"; lastError: StructuredOutputError; calls: LlmCallAttempt[] }
  | { kind: "stopped"; stopReason: "max_tokens" | "refusal" | "other"; calls: LlmCallAttempt[] }
  | { kind: "provider_error"; llmErrorKind: LlmErrorKind; message: string; calls: LlmCallAttempt[] };

export interface StructuredPromptSuccess<T> {
  data: T;
  calls: LlmCallAttempt[];
}

export const MAX_STRUCTURED_ATTEMPTS_LIMIT = 3;

export interface StructuredPromptOptions {
  model: string;
  effort?: LlmEffort;
  /** Tentativas por saída inválida (1..3). */
  maxAttempts: number;
}

function retryMessage(original: string, previous: string, error: StructuredOutputError): string {
  return [
    original,
    "",
    "## Correção necessária",
    "Uma tentativa anterior foi rejeitada pela validação automática.",
    describeError(error),
    "",
    "Gere novamente a resposta completa, corrigindo esses pontos e mantendo todas as demais regras.",
    previous.trim() ? `\nResposta rejeitada (para referência):\n${previous.slice(0, 20_000)}` : "",
  ].join("\n");
}

/**
 * Executa um prompt versionado com saída estruturada e validação Zod.
 * - Saída inválida/vazia → nova tentativa com o erro como feedback, até `maxAttempts` (máx. 3).
 * - `max_tokens`/`refusal` → falha imediata (repetir não resolve e só gasta).
 * - Erro de provider → falha imediata (o SDK já fez seus retries de transporte).
 * Em QUALQUER desfecho, `calls` traz todas as chamadas feitas para registro de custo.
 */
export async function runStructuredPrompt<TInput, TOutput>(
  client: LlmClient,
  prompt: PromptDefinition<TInput, TOutput>,
  input: TInput,
  options: StructuredPromptOptions,
): Promise<Result<StructuredPromptSuccess<TOutput>, StructuredPromptFailure>> {
  const { maxAttempts } = options;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_STRUCTURED_ATTEMPTS_LIMIT) {
    throw new RangeError(`maxAttempts deve estar entre 1 e ${MAX_STRUCTURED_ATTEMPTS_LIMIT}`);
  }

  const original = prompt.buildUserMessage(input);
  const validation = prompt.validationSchemaFor(input);
  const calls: LlmCallAttempt[] = [];
  let userMessage = original;
  let lastError: StructuredOutputError = { kind: "empty_response" };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response;
    try {
      response = await client.complete({
        model: options.model,
        effort: options.effort,
        system: prompt.system,
        messages: [{ role: "user", content: userMessage }],
        maxTokens: prompt.maxTokensFor(input),
        outputSchema: prompt.outputSchema,
        cacheSystemPrompt: true,
      });
    } catch (error) {
      if (!(error instanceof LlmError)) throw error;
      calls.push({
        attempt,
        requestedModel: options.model,
        servedModel: options.model,
        requestId: error.meta.requestId ?? null,
        usage: ZERO_USAGE,
        stopReason: null,
        outcome: "provider_error",
        errorSummary: error.message,
        durationMs: 0,
      });
      return err({ kind: "provider_error", llmErrorKind: error.kind, message: error.message, calls });
    }

    const base = {
      attempt,
      requestedModel: response.requestedModel,
      servedModel: response.servedModel,
      requestId: response.requestId,
      usage: response.usage,
      stopReason: response.rawStopReason,
      durationMs: response.durationMs,
    };

    if (response.stopReason === "max_tokens" || response.stopReason === "refusal") {
      calls.push({ ...base, outcome: response.stopReason });
      return err({ kind: "stopped", stopReason: response.stopReason, calls });
    }

    const parsed = parseStructuredOutput(response.text, validation);
    if (parsed.ok) {
      calls.push({ ...base, outcome: "valid" });
      return ok({ data: parsed.value, calls });
    }

    lastError = parsed.error;
    calls.push({ ...base, outcome: parsed.error.kind, errorSummary: describeError(parsed.error).slice(0, 2_000) });
    userMessage = retryMessage(original, response.text, parsed.error);
  }

  return err({ kind: "retry_exhausted", lastError, calls });
}
