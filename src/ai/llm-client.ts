import type { z } from "zod";
import type { TokenUsage } from "@/domain/llm";
import type { LlmEffort } from "@/domain/quality";

/**
 * Abstração de um LLM. Pipeline, prompts e planners dependem só daqui.
 * Implementações: AnthropicLlmClient (ai/anthropic/) e clientes falsos nos testes.
 */

export interface LlmMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LlmRequest {
  model: string;
  system: string;
  messages: LlmMessage[];
  maxTokens: number;
  effort?: LlmEffort;
  /** Pede saída estruturada nativa da API. A validação final é SEMPRE nossa (Zod). */
  outputSchema?: z.ZodType;
  /** Marca o system prompt (prefixo estável) como cacheável. */
  cacheSystemPrompt?: boolean;
}

export type LlmStopReason = "end_turn" | "max_tokens" | "refusal" | "other";

export interface LlmResponse {
  /** Texto concatenado dos blocos de texto (blocos de raciocínio são ignorados). */
  text: string;
  usage: TokenUsage;
  requestedModel: string;
  /** Modelo que efetivamente respondeu, conforme a API. */
  servedModel: string;
  requestId: string | null;
  stopReason: LlmStopReason;
  rawStopReason: string | null;
  durationMs: number;
}

export interface LlmClient {
  readonly provider: string;
  readonly isMock: boolean;
  complete(request: LlmRequest): Promise<LlmResponse>;
}

export const LLM_ERROR_KINDS = [
  "missing_credentials",
  "invalid_credentials",
  "permission_denied",
  "rate_limited",
  "timeout",
  "connection_error",
  "bad_request",
  "provider_error",
] as const;
export type LlmErrorKind = (typeof LLM_ERROR_KINDS)[number];

const DEFAULT_MESSAGES: Record<LlmErrorKind, string> = {
  missing_credentials: "ANTHROPIC_API_KEY não configurada. Defina a variável de ambiente para usar o Claude real.",
  invalid_credentials: "A API key da Anthropic foi recusada (inválida ou revogada).",
  permission_denied: "A API key não tem permissão para este modelo ou recurso.",
  rate_limited: "Limite de requisições da Anthropic atingido. Tente novamente em instantes.",
  timeout: "A chamada ao Claude excedeu o tempo limite.",
  connection_error: "Falha de conexão com a API da Anthropic.",
  bad_request: "A requisição foi rejeitada pela API da Anthropic.",
  provider_error: "Erro no provedor do LLM.",
};

/**
 * Erro interno de LLM. Nunca carrega a API key nem o objeto de erro bruto do SDK.
 */
export class LlmError extends Error {
  override name = "LlmError";
  constructor(
    readonly kind: LlmErrorKind,
    detail?: string,
    readonly meta: { status?: number; requestId?: string | null; retryable: boolean } = { retryable: false },
  ) {
    super(detail ? `${DEFAULT_MESSAGES[kind]} (${detail})` : DEFAULT_MESSAGES[kind]);
  }
}

export const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
  };
}
