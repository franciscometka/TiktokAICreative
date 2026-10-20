import { describe, expect, it } from "vitest";
import { CLAUDE_MODELS } from "@/config/llm-models";
import { PRESET_ORDER, QUALITY_PRESETS } from "@/config/quality-presets";
import { evaluatePlanAgainstPreset } from "@/costs/plan-evaluation";
import { resolvePricing } from "@/costs/calculate";
import { CampaignPlanDraftSchema } from "@/domain/campaign";
import { generatedVideoSeconds, requiresGeneratedVideoForVisualSource } from "@/domain/creative";
import { sequentialIds } from "@/lib/ids";
import { ScriptedLlm, response } from "@/test/fake-llm";
import { catalog, product } from "@/test/fixtures";
import { LlmError } from "./llm-client";
import { LlmCreativePlanner } from "./llm-planner";
import { MockCreativePlanner, buildMockDraft } from "./mock-planner";
import { PlanningError, type PlanningRequest } from "./planner";
import { ACTIVE_PROMPTS } from "./prompts/registry";

function request(over: Partial<PlanningRequest> = {}): PlanningRequest {
  return { product: product(), styles: ["ugc", "review"], creativeCount: 2, settings: QUALITY_PRESETS.economy, ...over };
}

const validJson = (req: PlanningRequest) => JSON.stringify(buildMockDraft(req));

describe("seleção de modelo Claude por preset", () => {
  it("economy e high usam Sonnet 5.5; premium usa Opus 5.5", () => {
    expect(QUALITY_PRESETS.economy.llm.model).toBe(CLAUDE_MODELS.sonnet);
    expect(QUALITY_PRESETS.high.llm.model).toBe(CLAUDE_MODELS.sonnet);
    expect(QUALITY_PRESETS.premium.llm.model).toBe(CLAUDE_MODELS.opus);
    expect(CLAUDE_MODELS).toEqual({ opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5" });
  });

  it.each([
    ["economy", CLAUDE_MODELS.sonnet],
    ["high", CLAUDE_MODELS.sonnet],
    ["premium", CLAUDE_MODELS.opus],
  ] as const)("planner envia o modelo do preset %s → %s", async (quality, model) => {
    const req = request({ settings: QUALITY_PRESETS[quality] });
    const llm = new ScriptedLlm([response(validJson(req))]);
    await new LlmCreativePlanner(llm, sequentialIds(), { maxValidationAttempts: 2 }).plan(req);
    expect(llm.requests[0]?.model).toBe(model);
    expect(llm.requests[0]?.effort).toBe(QUALITY_PRESETS[quality].llm.effort);
  });
});

describe("LlmCreativePlanner (LLM isolado por mock)", () => {
  it("resposta válida → parse → Zod → hydrate com IDs internos", async () => {
    const req = request();
    const llm = new ScriptedLlm([response(validJson(req))]);
    const result = await new LlmCreativePlanner(llm, sequentialIds(), { maxValidationAttempts: 2 }).plan(req);

    expect(result.simulated).toBe(false);
    expect(result.promptId).toBe(ACTIVE_PROMPTS.campaignPlan.id);
    expect(result.plan.creatives).toHaveLength(2);
    expect(result.plan.creatives[0]?.id).toBe("creative_1");
    expect(result.plan.creatives[0]?.scenes.map((s) => s.order)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(result.calls).toHaveLength(1);
    expect(llm.requests[0]?.outputSchema).toBe(ACTIVE_PROMPTS.campaignPlan.outputSchema);
  });

  it("quantidade errada de criativos é rejeitada e re-pedida (regra fora do JSON Schema)", async () => {
    const req = request();
    const wrong = JSON.stringify(buildMockDraft({ ...req, creativeCount: 1 }));
    const llm = new ScriptedLlm([response(wrong), response(validJson(req))]);
    const result = await new LlmCreativePlanner(llm, sequentialIds(), { maxValidationAttempts: 2 }).plan(req);
    expect(result.calls.map((c) => c.outcome)).toEqual(["schema_mismatch", "valid"]);
    expect(llm.requests[1]?.messages[0]?.content).toContain("Esperado exatamente 2 criativo(s)");
  });

  it("normaliza requiresGeneratedVideo contraditório nas cenas 1 e 3 sem nova chamada", async () => {
    const req = request({ creativeCount: 1 });
    const draft = buildMockDraft(req);
    const scenes = draft.creatives[0]!.scenes.map((scene, index) =>
      index === 1 || index === 3 ? { ...scene, requiresGeneratedVideo: !scene.requiresGeneratedVideo } : scene);
    const llm = new ScriptedLlm([response(JSON.stringify({ ...draft, creatives: [{ ...draft.creatives[0]!, scenes }] }))]);
    const result = await new LlmCreativePlanner(llm, sequentialIds(), { maxValidationAttempts: 2 }).plan(req);
    expect(llm.requests).toHaveLength(1);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]?.outcome).toBe("valid");
    expect(result.plan.creatives[0]!.scenes.every(scene => scene.requiresGeneratedVideo === requiresGeneratedVideoForVisualSource(scene.visualSource))).toBe(true);
  });

  it("erro criativo não derivável continua usando repair", async () => {
    const req = request({ creativeCount: 1 });
    const invalid = buildMockDraft(req);
    invalid.creatives[0]!.scenes[0]!.visualDescription = "";
    const llm = new ScriptedLlm([response(JSON.stringify(invalid)), response(validJson(req))]);
    const result = await new LlmCreativePlanner(llm, sequentialIds(), { maxValidationAttempts: 2 }).plan(req);
    expect(llm.requests).toHaveLength(2);
    expect(result.calls.map(call => call.outcome)).toEqual(["schema_mismatch", "valid"]);
  });

  it("estilo fora dos permitidos é rejeitado", async () => {
    const req = request({ styles: ["review"] , creativeCount: 1 });
    const draft = buildMockDraft({ ...req, styles: ["ugc"] });
    const llm = new ScriptedLlm([response(JSON.stringify(draft))]);
    const planner = new LlmCreativePlanner(llm, sequentialIds(), { maxValidationAttempts: 1 });
    await expect(planner.plan(req)).rejects.toMatchObject({ kind: "retry_exhausted" });
  });

  it("schema inválido até esgotar as tentativas → PlanningError com as chamadas para cobrança", async () => {
    const llm = new ScriptedLlm([response("{}"), response('{"analysis":1}')]);
    const error = await new LlmCreativePlanner(llm, sequentialIds(), { maxValidationAttempts: 2 })
      .plan(request())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlanningError);
    expect((error as PlanningError).kind).toBe("retry_exhausted");
    expect((error as PlanningError).calls).toHaveLength(2);
    expect((error as PlanningError).message).toContain("limite de tentativas");
  });

  it("erros do provider viram PlanningError tipado", async () => {
    const llm = new ScriptedLlm([new LlmError("invalid_credentials")]);
    const error = await new LlmCreativePlanner(llm, sequentialIds(), { maxValidationAttempts: 2 })
      .plan(request())
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ kind: "provider_error" });
    expect((error as Error).message).toContain("recusada");
  });

  it("pior caso de custo considera tokens máximos e número de tentativas", () => {
    const planner = new LlmCreativePlanner(new ScriptedLlm([]), sequentialIds(), { maxValidationAttempts: 2 });
    const wc = planner.worstCase(request({ creativeCount: 3 }));
    expect(wc.maxAttempts).toBe(2);
    expect(wc.maxOutputTokens).toBe(ACTIVE_PROMPTS.campaignPlan.maxTokensFor(request({ creativeCount: 3 })));
    expect(wc.estimatedInputTokens).toBeGreaterThan(1000);
  });
});

describe("MockCreativePlanner", () => {
  it.each(PRESET_ORDER)("gera plano válido dentro do preset %s", async (quality) => {
    const settings = QUALITY_PRESETS[quality];
    const result = await new MockCreativePlanner(sequentialIds()).plan(request({ creativeCount: 3, settings }));
    const pricing = resolvePricing(settings, catalog);

    expect(result.simulated).toBe(true);
    expect(result.calls[0]?.requestedModel).toBe(settings.llm.model);
    expect(result.plan.creatives.map((c) => c.concept.format)).toEqual(["ugc", "review", "ugc"]);
    for (const creative of result.plan.creatives) {
      expect(evaluatePlanAgainstPreset(creative, settings, pricing, 5).valid).toBe(true);
      const gen = generatedVideoSeconds(creative);
      expect(gen).toBeGreaterThanOrEqual(settings.generatedVideoSeconds.min);
      expect(creative.duration).toBeGreaterThan(gen);
    }
  });

  it("o rascunho do mock segue o mesmo schema de validação exigido do Claude", () => {
    const req = request({ styles: ["curiosity"], creativeCount: 1, settings: QUALITY_PRESETS.high });
    const draft = buildMockDraft(req);
    expect(CampaignPlanDraftSchema.safeParse(draft).success).toBe(true);
    expect(ACTIVE_PROMPTS.campaignPlan.validationSchemaFor(req).safeParse(draft).success).toBe(true);
  });
});

describe("prompt campaign-plan", () => {
  const p = ACTIVE_PROMPTS.campaignPlan;

  it("é versionado, ativo e com system prompt estável (cacheável)", () => {
    expect(p.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(p.status).toBe("active");
    expect(p.system).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("mensagem do usuário carrega produto, estilos e limites do preset", () => {
    const msg = p.buildUserMessage(request());
    expect(msg).toContain("Garrafa Térmica X");
    expect(msg).toContain("ugc");
    expect(msg).toContain("entre 8 e 12 segundos");
    expect(msg).toContain("nunca acima de 12s");
  });

  it("sem imagens, orienta a não usar product_image", () => {
    expect(p.buildUserMessage(request({ product: product({ images: [] }) }))).toContain('não use visualSource "product_image"');
  });

  it("maxTokens cresce com a quantidade de criativos, com teto", () => {
    expect(p.maxTokensFor(request({ creativeCount: 1 }))).toBeLessThan(p.maxTokensFor(request({ creativeCount: 3 })));
    expect(p.maxTokensFor(request({ creativeCount: 10 }))).toBeLessThanOrEqual(64_000);
  });
});
