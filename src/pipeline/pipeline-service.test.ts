import { describe, expect, it } from "vitest";
import { OverBudgetNotAllowedError } from "@/costs/budget";
import type { CostBudget } from "@/domain/cost";
import type { CampaignRequest } from "@/domain/pipeline";
import { BUDGET, campaignRequest, createHarness, type HarnessOptions } from "@/test/fixtures";
import { ApprovalRequiredError, AttemptLimitReachedError, StaleEstimateError, UnexpectedStatusError } from "./guards";
import { PlanningBudgetError } from "./pipeline-service";

type Harness = ReturnType<typeof createHarness>;

/*
 * Plano mock (economy, cotação 5): 25s finais, 10s de vídeo IA em 3 cenas
 * (scene_1 = 2.5s, scene_3 = 4s, scene_5 = 3.5s). Vídeo a US$0.08/s → R$4,00.
 * Estimativa total ≈ R$4,48 (LLM R$0,42 já incorrido + vídeo + áudio).
 */

async function planned(h: Harness, over: Partial<CampaignRequest> = {}) {
  const campaign = await h.service.planCampaign(campaignRequest(over));
  const jobId = campaign.jobIds[0];
  if (!jobId) throw new Error("sem job");
  return { campaign, jobId };
}

async function approved(h: Harness, over: Partial<CampaignRequest> = {}) {
  const { campaign, jobId } = await planned(h, over);
  const estimated = await h.service.estimateCost(jobId);
  await h.service.requestApproval(jobId);
  const outcome = await h.service.approve(jobId, { estimateId: estimated.estimate!.id });
  return { campaign, jobId, outcome, estimate: estimated.estimate! };
}

async function completed(options: HarnessOptions = {}, budget: CostBudget = BUDGET) {
  const h = createHarness(options);
  const { jobId, campaign } = await approved(h, { budget });
  const outcome = await h.service.generate(jobId);
  expect(outcome.kind).toBe("COMPLETED");
  return { h, jobId, campaign };
}

describe("planejamento (planner mock)", () => {
  it("cria campanha planejada, jobs já estimados e custo SIMULADO do LLM no nível da campanha", async () => {
    const h = createHarness();
    const { campaign } = await planned(h, { creativeCount: 2 });
    expect(campaign.status).toBe("planned");
    expect(campaign.plannerId).toBe("mock");
    expect(campaign.jobIds).toHaveLength(2);
    expect(campaign.reviews).toHaveLength(2);
    const jobs = await h.store.listJobs(campaign.id);
    expect(jobs.every((j) => j.status === "cost_estimated" && j.estimate !== undefined)).toBe(true);

    const llm = await h.ledger.list({ jobId: null });
    expect(llm.map((e) => [e.category, e.operation])).toEqual([
      ["llm", "campaign_plan"],
      ["llm", "campaign_plan"],
    ]);
    expect(llm.every((e) => e.simulated)).toBe(true);
    // Sonnet 5.5: (2×2k entrada × US$2 + 2×6k saída × US$10)/1M = US$0.128 → R$0,64
    expect(llm.reduce((a, e) => a + e.costBrl, 0)).toBeCloseTo(0.64, 2);
    expect((await h.llmCallLog.list())[0]).toMatchObject({ simulated: true, requestedModel: "claude-sonnet-5-5" });
  });

  it("não planeja se o custo estimado do planejamento já excede o orçamento da campanha", async () => {
    const h = createHarness();
    await expect(
      h.service.planCampaign(campaignRequest({ budget: { ...BUDGET, maxCostPerCampaignBrl: 0.1 } })),
    ).rejects.toThrow(PlanningBudgetError);
  });
});

describe("aprovação humana obrigatória", () => {
  it("nenhuma chamada paga acontece antes da aprovação", async () => {
    const h = createHarness();
    const { jobId } = await planned(h);
    await expect(h.service.generate(jobId)).rejects.toThrow(UnexpectedStatusError);

    await h.service.estimateCost(jobId);
    await expect(h.service.generate(jobId)).rejects.toThrow(UnexpectedStatusError);

    const request = await h.service.requestApproval(jobId);
    expect(request.estimate.kind).toBe("estimate");
    expect(request.budgetCheck.kind).toBe("WITHIN_BUDGET");
    await expect(h.service.generate(jobId)).rejects.toThrow(ApprovalRequiredError);

    expect(h.video.generateCalls).toHaveLength(0);
    expect(h.audio.generateCalls).toHaveLength(0);
    expect(await h.ledger.list({ jobId })).toHaveLength(0);
  });

  it("nova estimativa invalida a aprovação anterior", async () => {
    const h = createHarness();
    const { jobId, estimate } = await approved(h);
    const reestimated = await h.service.estimateCost(jobId);
    expect(reestimated.approval).toBeUndefined();
    await h.service.requestApproval(jobId);
    await expect(h.service.generate(jobId)).rejects.toThrow(ApprovalRequiredError);
    await expect(h.service.approve(jobId, { estimateId: estimate.id })).rejects.toThrow(StaleEstimateError);
    expect(h.video.generateCalls).toHaveLength(0);
  });

  it("fluxo completo com mocks: gera, renderiza e separa estimado × real", async () => {
    const { h, jobId } = await completed();
    const job = await h.store.getJob(jobId);
    expect(job.status).toBe("completed");
    expect(job.outputUri).toMatch(/^mock:\/\/render\//);
    expect(h.video.generateCalls).toHaveLength(3);
    expect(h.audio.generateCalls).toHaveLength(1);
    expect(job.manifest?.duration).toBe(25);
    expect(job.manifest?.generatedVideoSeconds).toBe(10);

    const report = await h.service.getJobCostReport(jobId);
    expect(report.estimate?.kind).toBe("estimate");
    expect(report.actual.kind).toBe("actual");
    expect(report.actual.includesSimulated).toBe(true);
    expect(report.actual.byCategoryBrl.video).toBeCloseTo(4, 2);
    expect(report.actual.discardedBrl).toBe(0);
  });
});

describe("orçamento na aprovação", () => {
  const tight: CostBudget = { maxCostPerCreativeBrl: 3, maxCostPerCampaignBrl: 100, allowOverBudget: true };

  it("retorna BUDGET_EXCEEDED e não aprova sem autorização explícita", async () => {
    const h = createHarness();
    const { jobId, outcome } = await approved(h, { budget: tight });
    expect(outcome.kind).toBe("BUDGET_EXCEEDED");
    if (outcome.kind !== "BUDGET_EXCEEDED") return;
    expect(outcome.decision).toMatchObject({ scope: "creative", budgetBrl: 3, canAuthorizeOverBudget: true });
    expect(outcome.decision.newEstimatedTotalBrl).toBeGreaterThan(3);

    const job = await h.store.getJob(jobId);
    expect(job.approval).toBeUndefined();
    expect(job.pendingBudgetDecision?.kind).toBe("BUDGET_EXCEEDED");
    await expect(h.service.generate(jobId)).rejects.toThrow(ApprovalRequiredError);
  });

  it("aprova com autorização explícita quando a política permite", async () => {
    const h = createHarness();
    const { jobId, estimate } = await approved(h, { budget: tight });
    const outcome = await h.service.approve(jobId, { estimateId: estimate.id, authorizeOverBudget: true });
    expect(outcome.kind).toBe("APPROVED");
    if (outcome.kind === "APPROVED") expect(outcome.job.approval?.overBudget).toBe(true);
  });

  it("recusa autorização quando allowOverBudget = false", async () => {
    const h = createHarness();
    const { jobId, estimate } = await approved(h, { budget: { ...tight, allowOverBudget: false } });
    await expect(
      h.service.approve(jobId, { estimateId: estimate.id, authorizeOverBudget: true }),
    ).rejects.toThrow(OverBudgetNotAllowedError);
  });

  it("limite por campanha considera o compromisso de outros criativos aprovados", async () => {
    const h = createHarness();
    const budget: CostBudget = { maxCostPerCreativeBrl: 15, maxCostPerCampaignBrl: 6, allowOverBudget: false };
    const campaign = await h.service.planCampaign(campaignRequest({ creativeCount: 2, budget }));
    const [first, second] = campaign.jobIds as [string, string];

    for (const id of [first, second]) {
      await h.service.estimateCost(id);
      await h.service.requestApproval(id);
    }
    const e1 = (await h.store.getJob(first)).estimate!;
    const e2 = (await h.store.getJob(second)).estimate!;
    expect((await h.service.approve(first, { estimateId: e1.id })).kind).toBe("APPROVED");

    const outcome = await h.service.approve(second, { estimateId: e2.id });
    expect(outcome.kind).toBe("BUDGET_EXCEEDED");
    if (outcome.kind === "BUDGET_EXCEEDED") {
      expect(outcome.decision.scope).toBe("campaign");
      expect(outcome.decision.canAuthorizeOverBudget).toBe(false);
    }
  });
});

describe("orçamento durante a geração", () => {
  it("pausa em budget_exceeded quando o custo real supera o estimado; autorização não é cheque em branco", async () => {
    // Provider cobra 3× o estimado.
    const h = createHarness({ video: { billingMultiplier: 3 } });
    const budget: CostBudget = { maxCostPerCreativeBrl: 6, maxCostPerCampaignBrl: 100, allowOverBudget: true };
    const { jobId, outcome } = await approved(h, { budget });
    expect(outcome.kind).toBe("APPROVED");

    const first = await h.service.generate(jobId);
    expect(first.kind).toBe("BUDGET_EXCEEDED");
    expect(h.video.generateCalls).toHaveLength(1);
    expect((await h.store.getJob(jobId)).status).toBe("budget_exceeded");

    // Autoriza até o total mostrado; a próxima cena volta a estourar → nova decisão.
    const second = await h.service.resolveBudgetDecision(jobId, "authorize");
    expect(second.kind).toBe("BUDGET_EXCEEDED");
    expect(h.video.generateCalls).toHaveLength(2);

    const cancelled = await h.service.resolveBudgetDecision(jobId, "cancel");
    expect(cancelled.job.status).toBe("cancelled");
    // Custos das tentativas já feitas continuam registrados.
    const report = await h.service.getJobCostReport(jobId);
    expect(report.actual.entryCount).toBe(2);
    expect(report.actual.totalBrl).toBeGreaterThan(report.estimate!.videoCost.brl);
  });
});

describe("falhas", () => {
  it("falha do provider não é re-tentada automaticamente e o custo faturado é registrado", async () => {
    const h = createHarness({ video: { failSceneIds: new Set(["scene_1"]), billFailures: true } });
    const { jobId } = await approved(h);
    const outcome = await h.service.generate(jobId);
    expect(outcome.kind).toBe("FAILED");
    expect(h.video.generateCalls).toHaveLength(1);

    const job = await h.store.getJob(jobId);
    expect(job.status).toBe("failed");
    expect(job.scenes[0]?.attempts[0]).toMatchObject({ status: "failed", active: false });

    const report = await h.service.getJobCostReport(jobId);
    expect(report.actual.totalBrl).toBeCloseTo(1, 2); // 2.5s × US$0.08 × 5
    expect(report.actual.discardedBrl).toBeCloseTo(1, 2);

    // Retomar exige nova estimativa + nova aprovação.
    await expect(h.service.generate(jobId)).rejects.toThrow(UnexpectedStatusError);
  });
});

describe("regeneração de cena", () => {
  it("toda tentativa entra no custo real; a anterior vira descartada", async () => {
    const { h, jobId } = await completed();
    const before = await h.service.getJobCostReport(jobId);

    const outcome = await h.service.regenerateScene(jobId, "scene_3");
    expect(outcome.kind).toBe("REGENERATED");
    expect(h.video.generateCalls).toHaveLength(4);

    const job = await h.store.getJob(jobId);
    const attempts = job.scenes.find((s) => s.sceneId === "scene_3")!.attempts;
    expect(attempts.map((a) => [a.attemptNumber, a.active])).toEqual([
      [1, false],
      [2, true],
    ]);

    const after = await h.service.getJobCostReport(jobId);
    // 4s × US$0.08 × 5 = R$1,60 a mais; o custo da primeira tentativa não some.
    expect(after.actual.totalBrl).toBeCloseTo(before.actual.totalBrl + 1.6, 2);
    expect(after.actual.discardedBrl).toBeCloseTo(1.6, 2);
    expect(job.manifest?.assets.find((a) => a.sceneId === "scene_3")?.uri).toBe(attempts[1]?.assetUri);
  });

  it("regeneração que estoura o limite devolve BUDGET_EXCEEDED sem executar", async () => {
    const budget: CostBudget = { maxCostPerCreativeBrl: 5, maxCostPerCampaignBrl: 100, allowOverBudget: true };
    const { h, jobId } = await completed({}, budget);

    const outcome = await h.service.regenerateScene(jobId, "scene_3");
    expect(outcome.kind).toBe("BUDGET_EXCEEDED");
    if (outcome.kind === "BUDGET_EXCEEDED") {
      expect(outcome.decision.additionalEstimatedCostBrl).toBeCloseTo(1.6, 2);
      expect(outcome.decision.budgetBrl).toBe(5);
      expect(outcome.decision.newEstimatedTotalBrl).toBeCloseTo(
        outcome.decision.currentCostBrl + outcome.decision.additionalEstimatedCostBrl,
        2,
      );
    }
    expect(h.video.generateCalls).toHaveLength(3);
    expect((await h.store.getJob(jobId)).status).toBe("completed");

    const authorized = await h.service.regenerateScene(jobId, "scene_3", { authorizeOverBudget: true });
    expect(authorized.kind).toBe("REGENERATED");
  });

  it("limite de tentativas impede loops de regeneração", async () => {
    const { h, jobId } = await completed({ maxAttemptsPerScene: 2 });
    expect((await h.service.regenerateScene(jobId, "scene_1")).kind).toBe("REGENERATED");
    await expect(h.service.regenerateScene(jobId, "scene_1")).rejects.toThrow(AttemptLimitReachedError);
    expect(h.video.generateCalls).toHaveLength(4);
  });

  it("não regenera cenas que não usam vídeo IA", async () => {
    const { h, jobId } = await completed();
    await expect(h.service.regenerateScene(jobId, "scene_2")).rejects.toThrow(UnexpectedStatusError);
  });
});
