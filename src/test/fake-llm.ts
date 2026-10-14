import type { LlmClient, LlmRequest, LlmResponse } from "@/ai/llm-client";

/** Resposta roteirizada de um LLM falso. */
export function response(text: string, over: Partial<LlmResponse> = {}): LlmResponse {
  return {
    text,
    usage: { inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    requestedModel: "model-x",
    servedModel: "model-x",
    requestId: "req_test",
    stopReason: "end_turn",
    rawStopReason: over.stopReason ?? "end_turn",
    durationMs: 10,
    ...over,
  };
}

/**
 * LLM falso para testes: devolve respostas (ou lança erros) na ordem e registra as requisições.
 * Nenhuma rede, nenhum custo.
 */
export class ScriptedLlm implements LlmClient {
  readonly provider = "anthropic";
  readonly isMock = false;
  readonly requests: LlmRequest[] = [];

  constructor(private readonly script: (LlmResponse | Error)[]) {}

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push({ ...request, messages: request.messages.map((m) => ({ ...m })) });
    const next = this.script[this.requests.length - 1];
    if (!next) throw new Error("ScriptedLlm: sem mais respostas roteirizadas");
    if (next instanceof Error) throw next;
    return { ...next, requestedModel: request.model, servedModel: next.servedModel === "model-x" ? request.model : next.servedModel };
  }
}
