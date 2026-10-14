import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ScriptedLlm, response } from "@/test/fake-llm";
import { LlmError } from "./llm-client";
import type { PromptDefinition } from "./prompts/types";
import { parseStructuredOutput, runStructuredPrompt } from "./structured-output";

const Schema = z.object({ title: z.string().min(1), count: z.int() });

const prompt: PromptDefinition<{ topic: string }, z.infer<typeof Schema>> = {
  id: "test",
  version: "1.0.0",
  status: "active",
  system: "sys",
  buildUserMessage: ({ topic }) => `Tema: ${topic}`,
  outputSchema: Schema,
  validationSchemaFor: () => Schema.refine((d) => d.count > 0, { message: "count deve ser > 0", path: ["count"] }),
  maxTokensFor: () => 1000,
};

const opts = { model: "model-x", effort: "medium" as const, maxAttempts: 2 };

describe("parseStructuredOutput", () => {
  it("aceita JSON válido conforme schema", () => {
    expect(parseStructuredOutput('{"title":"ok","count":2}', Schema)).toEqual({ ok: true, value: { title: "ok", count: 2 } });
  });

  it("resposta vazia é erro próprio", () => {
    const r = parseStructuredOutput("   ", Schema);
    expect(r.ok === false && r.error.kind).toBe("empty_response");
  });

  it("retorna invalid_json para texto não-JSON", () => {
    const r = parseStructuredOutput("Claro! Aqui está:", Schema);
    expect(r.ok === false && r.error.kind).toBe("invalid_json");
  });

  it("NÃO tenta consertar JSON dentro de markdown (sem regex)", () => {
    const r = parseStructuredOutput('```json\n{"title":"ok","count":2}\n```', Schema);
    expect(r.ok === false && r.error.kind).toBe("invalid_json");
  });

  it("retorna schema_mismatch com caminhos dos problemas", () => {
    const r = parseStructuredOutput('{"title":"","count":1.5}', Schema);
    if (r.ok || r.error.kind !== "schema_mismatch") throw new Error("esperado schema_mismatch");
    expect(r.error.issues.map((i) => i.path).sort()).toEqual(["count", "title"]);
  });
});

describe("runStructuredPrompt", () => {
  it("sucesso na primeira tentativa, enviando modelo, esforço, schema e cache do system", async () => {
    const llm = new ScriptedLlm([response('{"title":"a","count":1}')]);
    const r = await runStructuredPrompt(llm, prompt, { topic: "x" }, opts);
    expect(r.ok && r.value.calls.map((c) => c.outcome)).toEqual(["valid"]);
    const req = llm.requests[0]!;
    expect(req).toMatchObject({ model: "model-x", effort: "medium", maxTokens: 1000, cacheSystemPrompt: true });
    expect(req.outputSchema).toBe(Schema);
    expect(req.messages).toEqual([{ role: "user", content: "Tema: x" }]);
  });

  it("valida com o schema dependente da entrada (regras além do JSON Schema)", async () => {
    const llm = new ScriptedLlm([response('{"title":"a","count":0}'), response('{"title":"a","count":3}')]);
    const r = await runStructuredPrompt(llm, prompt, { topic: "x" }, opts);
    expect(r.ok).toBe(true);
    expect(llm.requests[1]?.messages[0]?.content).toContain("count deve ser > 0");
  });

  it("retry com feedback; registra TODAS as chamadas com usage real", async () => {
    const llm = new ScriptedLlm([response("nada de json"), response('{"title":"a","count":1}')]);
    const r = await runStructuredPrompt(llm, prompt, { topic: "x" }, opts);
    if (!r.ok) throw new Error("esperado sucesso");
    expect(r.value.calls.map((c) => [c.attempt, c.outcome])).toEqual([
      [1, "invalid_json"],
      [2, "valid"],
    ]);
    expect(r.value.calls.every((c) => c.usage.inputTokens === 100)).toBe(true);
    // Retry é uma conversa nova de 1 turno (sem editar histórico), com o erro e a resposta rejeitada.
    const retry = llm.requests[1]!;
    expect(retry.messages).toHaveLength(1);
    expect(retry.messages[0]?.content).toContain("Tema: x");
    expect(retry.messages[0]?.content).toContain("não é JSON válido");
    expect(retry.messages[0]?.content).toContain("nada de json");
  });

  it("retry_exhausted respeita o limite e devolve as chamadas gastas", async () => {
    const llm = new ScriptedLlm([response("x"), response(""), response("z")]);
    const r = await runStructuredPrompt(llm, prompt, { topic: "x" }, opts);
    expect(llm.requests).toHaveLength(2);
    if (r.ok || r.error.kind !== "retry_exhausted") throw new Error("esperado retry_exhausted");
    expect(r.error.calls.map((c) => c.outcome)).toEqual(["invalid_json", "empty_response"]);
    expect(r.error.lastError.kind).toBe("empty_response");
  });

  it("maxAttempts = 1 desliga o retry", async () => {
    const llm = new ScriptedLlm([response("x"), response('{"title":"a","count":1}')]);
    const r = await runStructuredPrompt(llm, prompt, { topic: "x" }, { ...opts, maxAttempts: 1 });
    expect(r.ok).toBe(false);
    expect(llm.requests).toHaveLength(1);
  });

  it("não retenta quando a resposta foi truncada (max_tokens) ou recusada", async () => {
    for (const stopReason of ["max_tokens", "refusal"] as const) {
      const llm = new ScriptedLlm([response('{"title":', { stopReason }), response('{"title":"a","count":1}')]);
      const r = await runStructuredPrompt(llm, prompt, { topic: "x" }, opts);
      expect(llm.requests).toHaveLength(1);
      if (r.ok || r.error.kind !== "stopped") throw new Error("esperado stopped");
      expect(r.error.stopReason).toBe(stopReason);
      expect(r.error.calls[0]?.outcome).toBe(stopReason);
    }
  });

  it("erro do provider interrompe e preserva chamadas anteriores", async () => {
    const llm = new ScriptedLlm([response("inválido"), new LlmError("rate_limited", undefined, { retryable: true })]);
    const r = await runStructuredPrompt(llm, prompt, { topic: "x" }, opts);
    if (r.ok || r.error.kind !== "provider_error") throw new Error("esperado provider_error");
    expect(r.error.llmErrorKind).toBe("rate_limited");
    expect(r.error.calls.map((c) => c.outcome)).toEqual(["invalid_json", "provider_error"]);
  });

  it("rejeita limites de tentativa fora de 1..3 (proteção de custo)", async () => {
    const llm = new ScriptedLlm([]);
    await expect(runStructuredPrompt(llm, prompt, { topic: "x" }, { ...opts, maxAttempts: 10 })).rejects.toThrow(RangeError);
    await expect(runStructuredPrompt(llm, prompt, { topic: "x" }, { ...opts, maxAttempts: 0 })).rejects.toThrow(RangeError);
  });
});
