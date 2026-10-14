import Anthropic from "@anthropic-ai/sdk";
import { LlmError } from "../llm-client";

const MAX_DETAIL_LENGTH = 300;

/** Remove qualquer ocorrência da API key de um texto antes de expô-lo em erros/logs. */
export function makeRedactor(secret: string | undefined): (text: string) => string {
  return (text) => {
    let out = text;
    if (secret) out = out.split(secret).join("[REDACTED]");
    // Defesa extra: padrões de chave Anthropic mesmo que não sejam a chave atual.
    return out.replace(/sk-ant-[A-Za-z0-9_-]+/g, "[REDACTED]");
  };
}

/**
 * Converte erros do SDK em LlmError. Ordem: classes mais específicas primeiro
 * (APIConnectionTimeoutError estende APIConnectionError).
 */
export function mapAnthropicError(error: unknown, redact: (text: string) => string): LlmError {
  if (error instanceof LlmError) return error;
  const detail = (e: Error) => redact(e.message).slice(0, MAX_DETAIL_LENGTH);

  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return new LlmError("timeout", undefined, { retryable: true });
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new LlmError("connection_error", undefined, { retryable: true });
  }
  if (error instanceof Anthropic.APIError) {
    const meta = { status: error.status, requestId: error.requestID ?? null };
    if (error instanceof Anthropic.AuthenticationError) {
      return new LlmError("invalid_credentials", undefined, { ...meta, retryable: false });
    }
    if (error instanceof Anthropic.PermissionDeniedError) {
      return new LlmError("permission_denied", detail(error), { ...meta, retryable: false });
    }
    if (error instanceof Anthropic.RateLimitError) {
      return new LlmError("rate_limited", undefined, { ...meta, retryable: true });
    }
    if (
      error instanceof Anthropic.BadRequestError ||
      error instanceof Anthropic.NotFoundError ||
      error instanceof Anthropic.UnprocessableEntityError
    ) {
      return new LlmError("bad_request", detail(error), { ...meta, retryable: false });
    }
    return new LlmError("provider_error", `HTTP ${error.status ?? "?"}`, { ...meta, retryable: true });
  }
  if (error instanceof Error) {
    return new LlmError("provider_error", detail(error), { retryable: false });
  }
  return new LlmError("provider_error", undefined, { retryable: false });
}
