import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { TokenUsage } from "@/domain/llm";
import { LlmError, type LlmClient, type LlmRequest, type LlmResponse, type LlmStopReason } from "../llm-client";
import { mapAnthropicError, makeRedactor } from "./errors";

/**
 * ÚNICO módulo que conversa com o SDK da Anthropic. Nenhum outro arquivo importa @anthropic-ai/sdk
 * (exceto ./errors.ts para mapear as classes de erro).
 */

/** Porta de transporte: permite testar o cliente sem rede, injetando um SDK falso. */
export interface AnthropicTransport {
  send(params: Anthropic.MessageStreamParams): Promise<{ message: Anthropic.Message; requestId: string | null }>;
}

/** Transporte real: streaming + finalMessage() (evita timeout HTTP em respostas longas). */
export function sdkTransport(client: Anthropic): AnthropicTransport {
  return {
    async send(params) {
      const stream = client.messages.stream(params);
      const message = await stream.finalMessage();
      return { message, requestId: stream.request_id ?? null };
    },
  };
}

export interface AnthropicLlmClientOptions {
  /** Lida do ambiente pela fábrica. Nunca armazenada em campo público. */
  apiKey: string | undefined;
  timeoutMs: number;
  /** Retries de transporte do SDK (429/5xx/conexão). */
  maxRetries: number;
  /** Para testes. Se ausente, usa o SDK real. */
  transport?: AnthropicTransport;
  now?: () => number;
}

export class AnthropicLlmClient implements LlmClient {
  readonly provider = "anthropic";
  readonly isMock = false;
  readonly #transport: AnthropicTransport;
  readonly #redact: (text: string) => string;
  readonly #now: () => number;

  constructor(options: AnthropicLlmClientOptions) {
    if (!options.apiKey) throw new LlmError("missing_credentials");
    this.#redact = makeRedactor(options.apiKey);
    this.#now = options.now ?? Date.now;
    this.#transport =
      options.transport ??
      sdkTransport(new Anthropic({ apiKey: options.apiKey, timeout: options.timeoutMs, maxRetries: options.maxRetries }));
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const started = this.#now();
    let result: { message: Anthropic.Message; requestId: string | null };
    try {
      result = await this.#transport.send(buildParams(request));
    } catch (error) {
      throw mapAnthropicError(error, this.#redact);
    }
    return toLlmResponse(request, result.message, result.requestId, this.#now() - started);
  }
}

export function buildParams(request: LlmRequest): Anthropic.MessageStreamParams {
  const outputConfig: Anthropic.OutputConfig = {};
  if (request.effort) outputConfig.effort = request.effort;
  if (request.outputSchema) {
    // Só o JSON Schema: a validação (e os erros tipados) ficam na nossa camada, não no SDK.
    const { type, schema } = zodOutputFormat(request.outputSchema);
    outputConfig.format = { type, schema };
  }
  return {
    model: request.model,
    max_tokens: request.maxTokens,
    system: [
      {
        type: "text",
        text: request.system,
        ...(request.cacheSystemPrompt ? { cache_control: { type: "ephemeral" as const } } : {}),
      },
    ],
    messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
    ...(Object.keys(outputConfig).length > 0 ? { output_config: outputConfig } : {}),
  };
}

export function mapUsage(usage: Anthropic.Usage): TokenUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
  };
}

function mapStopReason(reason: Anthropic.StopReason | null): LlmStopReason {
  switch (reason) {
    case "end_turn":
      return "end_turn";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return "other";
  }
}

export function toLlmResponse(
  request: LlmRequest,
  message: Anthropic.Message,
  requestId: string | null,
  durationMs: number,
): LlmResponse {
  const text = message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");
  return {
    text,
    usage: mapUsage(message.usage),
    requestedModel: request.model,
    servedModel: message.model,
    requestId,
    stopReason: mapStopReason(message.stop_reason),
    rawStopReason: message.stop_reason,
    durationMs,
  };
}
