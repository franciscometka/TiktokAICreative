import { readAnthropicApiKey, type AppConfig } from "@/config/env";
import { AnthropicLlmClient } from "./anthropic/anthropic-llm-client";
import type { LlmClient } from "./llm-client";

/**
 * Cria o cliente LLM real. A API key é lida do ambiente AQUI e repassada só ao cliente;
 * ela não passa por AppConfig, logs, respostas ou componentes React.
 * Lança LlmError("missing_credentials") se a chave não existir.
 */
export function createAnthropicLlmClient(
  config: Pick<AppConfig, "llmPolicy">,
  env: Record<string, string | undefined> = process.env,
): LlmClient {
  return new AnthropicLlmClient({
    apiKey: readAnthropicApiKey(env),
    timeoutMs: config.llmPolicy.timeoutMs,
    maxRetries: config.llmPolicy.maxTransportRetries,
  });
}
