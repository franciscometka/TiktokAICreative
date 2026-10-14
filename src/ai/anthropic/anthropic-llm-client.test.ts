import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createAnthropicLlmClient } from "@/ai/create-llm-client";
import { LlmError, type LlmRequest } from "@/ai/llm-client";
import { DEFAULT_LLM_POLICY } from "@/config/env";
import { AnthropicLlmClient, buildParams, mapUsage, type AnthropicTransport } from "./anthropic-llm-client";
import { makeRedactor, mapAnthropicError } from "./errors";

const FAKE_KEY = "sk-ant-test-0123456789abcdef";

function message(over: Partial<Record<string, unknown>> = {}): Anthropic.Message {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content: [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "text", text: '{"a":', citations: null },
      { type: "text", text: "1}", citations: null },
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 1200,
      output_tokens: 3400,
      cache_creation_input_tokens: 900,
      cache_read_input_tokens: null,
    },
    ...over,
  } as unknown as Anthropic.Message;
}

class FakeTransport implements AnthropicTransport {
  readonly sent: Anthropic.MessageStreamParams[] = [];
  constructor(private readonly reply: Anthropic.Message | Error) {}
  async send(params: Anthropic.MessageStreamParams) {
    this.sent.push(params);
    if (this.reply instanceof Error) throw this.reply;
    return { message: this.reply, requestId: "req_123" };
  }
}

const baseRequest: LlmRequest = {
  model: "claude-sonnet-5-5",
  system: "sistema",
  messages: [{ role: "user", content: "oi" }],
  maxTokens: 8000,
  effort: "medium",
  outputSchema: z.object({ a: z.int() }),
  cacheSystemPrompt: true,
};

function client(reply: Anthropic.Message | Error) {
  const transport = new FakeTransport(reply);
  let t = 0;
  const llm = new AnthropicLlmClient({ apiKey: FAKE_KEY, timeoutMs: 1000, maxRetries: 0, transport, now: () => (t += 50) });
  return { llm, transport };
}

describe("AnthropicLlmClient — requisição", () => {
  it("monta parâmetros com modelo, esforço, saída estruturada e cache do system prompt", () => {
    const params = buildParams(baseRequest);
    expect(params.model).toBe("claude-sonnet-5-5");
    expect(params.max_tokens).toBe(8000);
    expect(params.system).toEqual([{ type: "text", text: "sistema", cache_control: { type: "ephemeral" } }]);
    expect(params.messages).toEqual([{ role: "user", content: "oi" }]);
    expect(params.output_config?.effort).toBe("medium");
    expect(params.output_config?.format?.type).toBe("json_schema");
    // Só o schema vai para a API; o parse/validação ficam na nossa camada.
    expect(params.output_config?.format).not.toHaveProperty("parse");
    expect(params).not.toHaveProperty("thinking");
  });

  it("sem schema/esforço não envia output_config", () => {
    const params = buildParams({ ...baseRequest, outputSchema: undefined, effort: undefined, cacheSystemPrompt: false });
    expect(params).not.toHaveProperty("output_config");
    expect(params.system).toEqual([{ type: "text", text: "sistema" }]);
  });
});

describe("AnthropicLlmClient — resposta e usage", () => {
  it("concatena só blocos de texto e mapeia usage, modelo, request id e duração", async () => {
    const { llm, transport } = client(message());
    const r = await llm.complete(baseRequest);
    expect(transport.sent).toHaveLength(1);
    expect(r.text).toBe('{"a":1}');
    expect(r.usage).toEqual({
      inputTokens: 1200,
      outputTokens: 3400,
      cacheCreationInputTokens: 900,
      cacheReadInputTokens: 0,
    });
    expect(r).toMatchObject({
      requestedModel: "claude-sonnet-5-5",
      servedModel: "claude-sonnet-5-5",
      requestId: "req_123",
      stopReason: "end_turn",
      rawStopReason: "end_turn",
      durationMs: 50,
    });
  });

  it("registra o modelo que REALMENTE respondeu", async () => {
    const { llm } = client(message({ model: "claude-opus-5-5" }));
    expect((await llm.complete(baseRequest)).servedModel).toBe("claude-opus-5-5");
  });

  it.each([
    ["max_tokens", "max_tokens"],
    ["model_context_window_exceeded", "max_tokens"],
    ["refusal", "refusal"],
    ["pause_turn", "other"],
  ])("stop_reason %s → %s", async (raw, mapped) => {
    const { llm } = client(message({ stop_reason: raw }));
    expect((await llm.complete(baseRequest)).stopReason).toBe(mapped);
  });

  it("mapUsage trata campos de cache nulos como 0", () => {
    expect(
      mapUsage({ input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: null, cache_read_input_tokens: 5 } as Anthropic.Usage),
    ).toEqual({ inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: 0, cacheReadInputTokens: 5 });
  });
});

describe("AnthropicLlmClient — erros e segurança", () => {
  it("sem API key → missing_credentials (antes de qualquer chamada)", () => {
    expect(() => new AnthropicLlmClient({ apiKey: undefined, timeoutMs: 1000, maxRetries: 0 })).toThrow(LlmError);
    expect(() => createAnthropicLlmClient({ llmPolicy: DEFAULT_LLM_POLICY }, {})).toThrow(/ANTHROPIC_API_KEY/);
  });

  const headers = new Headers({ "request-id": "req_err" });
  it.each([
    ["autenticação", new Anthropic.AuthenticationError(401, undefined, "invalid x-api-key", headers), "invalid_credentials", false],
    ["permissão", new Anthropic.PermissionDeniedError(403, undefined, "forbidden", headers), "permission_denied", false],
    ["rate limit", new Anthropic.RateLimitError(429, undefined, "slow down", headers), "rate_limited", true],
    ["bad request", new Anthropic.BadRequestError(400, undefined, "bad", headers), "bad_request", false],
    ["not found", new Anthropic.NotFoundError(404, undefined, "model not found", headers), "bad_request", false],
    ["5xx", new Anthropic.InternalServerError(529, undefined, "overloaded", headers), "provider_error", true],
    ["timeout", new Anthropic.APIConnectionTimeoutError(), "timeout", true],
    ["conexão", new Anthropic.APIConnectionError({ message: "ECONNRESET" }), "connection_error", true],
  ] as const)("erro de %s → %s", async (_label, sdkError, kind, retryable) => {
    const { llm } = client(sdkError);
    const error = await llm.complete(baseRequest).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).kind).toBe(kind);
    expect((error as LlmError).meta.retryable).toBe(retryable);
  });

  it("a API key nunca aparece em mensagens de erro", async () => {
    const leaky = new Anthropic.BadRequestError(400, undefined, `chave ${FAKE_KEY} e sk-ant-outra-chave`, headers);
    const { llm } = client(leaky);
    const error = (await llm.complete(baseRequest).catch((e: unknown) => e)) as LlmError;
    expect(error.message).not.toContain(FAKE_KEY);
    expect(error.message).not.toContain("sk-ant-outra-chave");
    expect(error.message).toContain("[REDACTED]");
    expect(JSON.stringify(error)).not.toContain(FAKE_KEY);
  });

  it("o cliente não expõe a key em campos enumeráveis/serialização", () => {
    const { llm } = client(message());
    expect(JSON.stringify(llm)).not.toContain(FAKE_KEY);
    expect(Object.values(llm).join(" ")).not.toContain(FAKE_KEY);
  });

  it("erros desconhecidos viram provider_error com detalhe redigido", () => {
    const e = mapAnthropicError(new Error(`falha ${FAKE_KEY}`), makeRedactor(FAKE_KEY));
    expect(e.kind).toBe("provider_error");
    expect(e.message).not.toContain(FAKE_KEY);
  });
});
