import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createAnthropicLlmClient } from "@/ai/create-llm-client";
import { AUXILIARY_LLM } from "@/config/llm-models";
import { DEFAULT_LLM_POLICY, readAnthropicApiKey } from "@/config/env";

/**
 * Teste de integração REAL (pago, centavos). NÃO roda em `npm test`.
 * Execução: RUN_PAID_TESTS=1 npm run test:integration
 * Usa o modelo auxiliar mais barato e uma saída estruturada mínima.
 */
const enabled = process.env.RUN_PAID_TESTS === "1" && readAnthropicApiKey() !== undefined;

describe.skipIf(!enabled)("Anthropic real (pago)", () => {
  it("responde com saída estruturada e usage real", async () => {
    const client = createAnthropicLlmClient({ llmPolicy: DEFAULT_LLM_POLICY });
    const r = await client.complete({
      model: AUXILIARY_LLM.model,
      effort: "low",
      system: "Responda apenas com o JSON pedido.",
      messages: [{ role: "user", content: "Devolva {\"ok\": true}." }],
      maxTokens: 256,
      outputSchema: z.object({ ok: z.boolean() }),
    });
    expect(JSON.parse(r.text)).toEqual({ ok: true });
    expect(r.usage.inputTokens).toBeGreaterThan(0);
    expect(r.requestId).toBeTruthy();
  }, 60_000);
});
