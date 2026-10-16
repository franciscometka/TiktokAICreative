import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LlmError } from "@/ai/llm-client";
import { LlmCreativePlanner } from "@/ai/llm-planner";
import { buildMockDraft } from "@/ai/mock-planner";
import { CLAUDE_MODELS } from "@/config/llm-models";
import { QUALITY_PRESETS } from "@/config/quality-presets";
import { generatedVideoSeconds } from "@/domain/creative";
import { sequentialIds } from "@/lib/ids";
import { FileCostLedger } from "@/storage/file-cost-ledger";
import { FilePipelineStore } from "@/storage/file-pipeline-store";
import { FileLlmCallLog } from "@/storage/llm-call-log";
import { ScriptedLlm, response } from "@/test/fake-llm";
import { BUDGET, campaignRequest, createHarness, product } from "@/test/fixtures";
import type { LlmResponse } from "@/ai/llm-client";
import type { PlanningRequest } from "@/ai/planner";

/** Uso "real" devolvido pela API falsa: 5k entrada, 20k saída, 1k leitura de cache. */
const USAGE = { inputTokens: 5_000, outputTokens: 20_000, cacheCreationInputTokens: 0, cacheReadInputTokens: 1_000 };

function planningRequest(quality: keyof typeof QUALITY_PRESETS = "economy", creativeCount = 1): PlanningRequest {
  return { product: product(), styles: ["ugc", "problem_solution"], creativeCount, settings: QUALITY_PRESETS[quality] };
}

function claudeHarness(script: (LlmResponse | Error)[], extra: Parameters<typeof createHarness>[0] = {}) {
  const llm = new ScriptedLlm(script);
  const h = createHarness({
    ...extra,
    planner: (ids) => new LlmCreativePlanner(llm, ids, { maxValidationAttempts: 2 }),
  });
  return { ...h, llm };
}

const ok = (req: PlanningRequest, over: Partial<LlmResponse> = {}) =>
  response(JSON.stringify(buildMockDraft(req)), { usage: USAGE, requestId: "req_ok", ...over });

describe("planejamento com Claude (API isolada por mock)", () => {
  it("registra o custo REAL (não simulado) a partir do usage, por chamada, com o modelo do preset", async () => {
    const { service, ledger, llmCallLog, llm } = claudeHarness([ok(planningRequest())]);
    const campaign = await service.planCampaign(campaignRequest({ creativeCount: 1 }));

    expect(campaign.status).toBe("planned");
    expect(campaign.plannerId).toBe("anthropic");
    expect(llm.requests[0]?.model).toBe(CLAUDE_MODELS.sonnet);

    const entries = await ledger.list({ jobId: null });
    expect(entries.every((e) => !e.simulated && e.operation === "campaign_plan" && e.model === CLAUDE_MODELS.sonnet)).toBe(true);
    expect(entries.map((e) => [e.unit, e.quantity])).toEqual([
      ["per_1m_input_tokens", 5_000],
      ["per_1m_output_tokens", 20_000],
      ["per_1m_cache_read_tokens", 1_000],
    ]);
    // 5k×2 + 20k×10 + 1k×0.2 (por 1M) = US$0.2102 → R$1,051 (cotação 5)
    const totalUsd = entries.reduce((a, e) => a + e.costUsd, 0);
    expect(totalUsd).toBeCloseTo(0.2102, 6);

    const [call] = await llmCallLog.list({ campaignId: campaign.id });
    expect(call).toMatchObject({
      simulated: false,
      requestId: "req_ok",
      requestedModel: CLAUDE_MODELS.sonnet,
      servedModel: CLAUDE_MODELS.sonnet,
      outcome: "valid",
      usage: USAGE,
      promptId: "campaign-plan",
      promptVersion: "1.5.0",
    });
    expect(call?.costUsd).toBeCloseTo(0.2102, 6);
    expect(entries.every((e) => e.llmCallId === call?.id)).toBe(true);
  });

  it("premium usa Opus 5.5 e paga o preço do Opus", async () => {
    const req = planningRequest("premium");
    const { service, ledger, llm } = claudeHarness([ok(req)], { quality: "premium" });
    await service.planCampaign(
      campaignRequest({ quality: "premium", creativeCount: 1, budget: { ...BUDGET, maxCostPerCreativeBrl: 60 } }),
    );
    expect(llm.requests[0]?.model).toBe(CLAUDE_MODELS.opus);
    const entries = await ledger.list({ jobId: null });
    expect(entries.every((e) => e.model === CLAUDE_MODELS.opus)).toBe(true);
    expect(entries.reduce((a, e) => a + e.costUsd, 0)).toBeCloseTo(5_000 * 4e-6 + 20_000 * 20e-6 + 1_000 * 0.2e-6, 6);
  });

  it("tentativa inválida também é cobrada e auditada", async () => {
    const { service, ledger, llmCallLog } = claudeHarness([
      response("{}", { usage: USAGE }),
      ok(planningRequest()),
    ]);
    const campaign = await service.planCampaign(campaignRequest({ creativeCount: 1 }));
    expect(campaign.status).toBe("planned");
    const calls = await llmCallLog.list();
    expect(calls.map((c) => c.outcome)).toEqual(["schema_mismatch", "valid"]);
    expect(calls[0]?.errorSummary).toContain("schema");
    expect((await ledger.list({ jobId: null })).reduce((a, e) => a + e.costUsd, 0)).toBeCloseTo(2 * 0.2102, 6);
  });

  it("falha do planejamento: campanha failed, mas custo das tentativas fica no ledger", async () => {
    const { service, ledger, store } = claudeHarness([response("x", { usage: USAGE }), response("y", { usage: USAGE })]);
    const campaign = await service.planCampaign(campaignRequest({ creativeCount: 1 }));
    expect(campaign.status).toBe("failed");
    expect(campaign.error).toContain("limite de tentativas");
    expect(campaign.jobIds).toEqual([]);
    expect((await store.getCampaign(campaign.id)).status).toBe("failed");
    expect((await ledger.list({ jobId: null })).length).toBe(6);
  });

  it("erro de credencial: campanha failed com mensagem clara, sem custo", async () => {
    const { service, ledger, llmCallLog } = claudeHarness([new LlmError("invalid_credentials")]);
    const campaign = await service.planCampaign(campaignRequest({ creativeCount: 1 }));
    expect(campaign.status).toBe("failed");
    expect(campaign.error).toContain("API key");
    expect(await ledger.list()).toHaveLength(0);
    expect((await llmCallLog.list())[0]?.outcome).toBe("provider_error");
  });

  it("plano acima do limite de segundos de IA é ajustado deterministicamente (nunca aceito acima)", async () => {
    // Claude "ignora" o preset Econômico (máx. 12s) e devolve plano no padrão Premium (~25s de IA).
    const { service, store } = claudeHarness([ok(planningRequest("premium"))]);
    const campaign = await service.planCampaign(campaignRequest({ creativeCount: 1 }));
    const review = campaign.reviews?.[0];
    expect(review?.original.valid).toBe(false);
    expect(review?.original.generatedSeconds).toBeGreaterThan(12);
    expect(review?.adjustments.length).toBeGreaterThan(0);
    expect(review?.final.valid).toBe(true);
    expect(generatedVideoSeconds(campaign.plan!.creatives[0]!)).toBeLessThanOrEqual(12);

    const job = await store.getJob(campaign.jobIds[0]!);
    expect(job.estimate?.generatedVideoSeconds).toBeLessThanOrEqual(12);
  });

  it("estimativa separa CUSTO JÁ INCORRIDO (real) de CUSTO FUTURO ESTIMADO; cancelar não devolve o incorrido", async () => {
    const req = planningRequest("economy", 2);
    const { service, store, ledger } = claudeHarness([ok(req)]);
    const campaign = await service.planCampaign(campaignRequest({ creativeCount: 2 }));
    const planningBrl = (await ledger.list({ jobId: null })).reduce((a, e) => a + e.costBrl, 0);

    const job = await store.getJob(campaign.jobIds[0]!);
    const estimate = job.estimate!;
    expect(estimate.incurred.sharedAmongCreatives).toBe(2);
    expect(estimate.incurred.simulated).toBe(false);
    // Rateio arredondado ao centavo.
    expect(Math.abs(estimate.incurred.llmCost.brl - planningBrl / 2)).toBeLessThanOrEqual(0.0051);
    expect(estimate.estimatedAdditionalBrl).toBeCloseTo(
      estimate.videoCost.brl + estimate.audioCost.brl + estimate.renderingCost.brl,
      1,
    );
    expect(estimate.projectedTotalBrl).toBeCloseTo(estimate.incurred.llmCost.brl + estimate.estimatedAdditionalBrl, 2);

    await service.cancel(job.id);
    const report = await service.getCampaignCostReport(campaign.id);
    expect(report.byCategoryBrl.llm).toBeCloseTo(planningBrl, 2);
  });

  it("checa o PIOR caso do planejamento contra o orçamento da campanha antes de chamar", async () => {
    const { service, llm } = claudeHarness([]);
    await expect(
      service.planCampaign(campaignRequest({ quality: "premium", budget: { ...BUDGET, maxCostPerCampaignBrl: 1 } })),
    ).rejects.toThrow(/pior caso/);
    expect(llm.requests).toHaveLength(0);
  });
});

describe("persistência: recuperação após restart", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("campanha, jobs, estimativas, aprovação, ledger e chamadas de LLM sobrevivem a um novo processo", async () => {
    dir = await mkdtemp(join(tmpdir(), "tacf-restart-"));
    const files = (d: string) => ({
      store: new FilePipelineStore(d),
      ledger: new FileCostLedger(d, () => undefined),
      llmCallLog: new FileLlmCallLog(d, () => undefined),
    });
    const ids = sequentialIds();

    // Processo 1: planeja com "Claude" e aprova.
    const first = claudeHarness([ok(planningRequest())], { storage: files(dir), ids });
    const campaign = await first.service.planCampaign(campaignRequest({ creativeCount: 1 }));
    const jobId = campaign.jobIds[0]!;
    const estimateId = (await first.store.getJob(jobId)).estimate!.id;
    await first.service.requestApproval(jobId);
    expect((await first.service.approve(jobId, { estimateId })).kind).toBe("APPROVED");
    const ledgerBefore = await first.ledger.list();

    // Processo 2: instâncias novas no mesmo diretório.
    const second = createHarness({ storage: files(dir), ids });
    const job = await second.store.getJob(jobId);
    expect(job.status).toBe("awaiting_approval");
    expect(job.approval?.estimateId).toBe(estimateId);
    expect((await second.store.getCampaign(campaign.id)).reviews).toHaveLength(1);
    expect((await second.ledger.list()).map((e) => e.id)).toEqual(ledgerBefore.map((e) => e.id));
    expect(await second.llmCallLog.list({ campaignId: campaign.id })).toHaveLength(1);

    // E o fluxo continua de onde parou.
    const outcome = await second.service.generate(jobId);
    expect(outcome.kind).toBe("COMPLETED");
    const report = await second.service.getJobCostReport(jobId);
    expect(report.actual.entryCount).toBeGreaterThan(0);
  });
});
