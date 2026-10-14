import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LlmError } from "@/ai/llm-client";
import { PlanningError } from "@/ai/planner";
import { UnavailablePlanner } from "@/ai/unavailable-planner";
import { InMemoryCostLedger } from "@/costs/ledger";
import { FilePipelineStore } from "@/storage/file-pipeline-store";
import { FileCostLedger } from "@/storage/file-cost-ledger";
import { FileLlmCallLog, InMemoryLlmCallLog } from "@/storage/llm-call-log";
import { InMemoryPipelineStore } from "@/storage/pipeline-store";
import type { LocalUploadStore } from "@/storage/upload-store";
import { formInput, GatedPlanner, PNG_BYTES, settle, tempUploads, until } from "@/test/app-fixtures";
import { sequentialIds } from "@/lib/ids";
import { createHarness } from "@/test/fixtures";
import {
  approveCreative,
  cancelCreative,
  getCampaignView,
  listCampaigns,
  resolveCreativeBudget,
  retryCampaignPlanning,
  startCampaignPlanning,
  uploadProductImage,
  type AppDeps,
} from "./campaign-actions";
import type { CampaignView } from "./campaign-view";

const META = { provider: "anthropic", promptId: "campaign-plan", promptVersion: "1.0.0", simulated: false };

type HarnessOptions = NonNullable<Parameters<typeof createHarness>[0]>;

async function setup(storage?: HarnessOptions["storage"], ids?: HarnessOptions["ids"]) {
  let planner!: GatedPlanner;
  const h = createHarness({ planner: (gen) => (planner = new GatedPlanner(gen)), storage, ids });
  const { uploads } = await tempUploads();
  const deps: AppDeps = { service: h.service, uploads, rendersDir: "outputs/renders" };
  return { h, planner, deps, uploads };
}

function ok<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(`esperava sucesso: ${JSON.stringify(result.error)}`);
  return result.value;
}

async function view(deps: AppDeps, id: string): Promise<CampaignView> {
  return ok(await getCampaignView(deps, id));
}

/** Campanha planejada (planner liberado). */
async function plannedCampaign(over: Parameters<typeof formInput>[0] = {}) {
  const ctx = await setup();
  const { campaignId } = ok(await startCampaignPlanning(ctx.deps, formInput(over)));
  ctx.planner.release();
  await settle();
  const v = await view(ctx.deps, campaignId);
  expect(v.state).toBe("planned");
  return { ...ctx, campaignId, view: v };
}

describe("criar campanha (action)", () => {
  it("erro de formulário volta por campo e nada é criado nem chamado", async () => {
    const { deps, planner } = await setup();
    const result = await startCampaignPlanning(deps, formInput({ name: "", creativeCount: 7 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("validation");
    expect(result.fieldErrors).toMatchObject({ name: expect.any(String), creativeCount: expect.any(String) });
    expect(await deps.service.listCampaignIds()).toEqual([]);
    expect(planner.calls).toBe(0);
  });

  it("retorna o campaignId sem esperar o planejamento terminar", async () => {
    const { deps, planner } = await setup();
    const { campaignId } = ok(await startCampaignPlanning(deps, formInput()));
    expect(planner.calls).toBe(1);
    const v = await view(deps, campaignId);
    expect(v.state).toBe("planning");
    expect(v.statusLabel).toBe("Planejando");
    expect(v.creatives).toEqual([]);
    expect(v.planning.startedAt).toBeDefined();
  });

  it("recusa antes de criar a campanha quando o Claude não está configurado", async () => {
    const h = createHarness({ planner: () => new UnavailablePlanner("anthropic", new LlmError("missing_credentials")) });
    const { uploads } = await tempUploads();
    const deps = { service: h.service, uploads, rendersDir: "outputs/renders" };
    const result = await startCampaignPlanning(deps, formInput());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("not_configured");
    expect(await h.service.listCampaignIds()).toEqual([]);
    expect(h.service.planningAvailable()).toBe(false);
  });

  it("usa só imagens que existem no store (URI decidida pelo servidor)", async () => {
    const { deps, uploads } = await setup();
    const image = ok(
      await uploadProductImage(deps, { productId: "prod_test", file: { bytes: PNG_BYTES, size: PNG_BYTES.length, type: "image/png" } }),
    );
    const missing = "img_00000000-0000-0000-0000-000000000000.png";
    const bad = await startCampaignPlanning(deps, formInput({ imageIds: [image.id, missing] }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.fieldErrors?.imageIds).toBeDefined();

    const { campaignId } = ok(await startCampaignPlanning(deps, formInput({ imageIds: [image.id] })));
    const campaign = await deps.service.getCampaign(campaignId);
    const [stored] = await (uploads as LocalUploadStore).list("prod_test");
    expect(campaign.request.product.images).toEqual([{ id: image.id, uri: stored?.uri, alt: "Garrafa Térmica X — imagem 1" }]);
    expect((await view(deps, campaignId)).product.images[0]?.previewUrl).toBe(`/api/uploads/prod_test/${image.id}`);
  });
});

describe("estado do planejamento (action de status)", () => {
  it("planning → planned com análise, hooks, criativos, cenas e estimativa", async () => {
    const { view: v } = await plannedCampaign({ creativeCount: 2 });
    expect(v.analysis?.summary).toContain("[MOCK]");
    expect(v.hooks.length).toBeGreaterThanOrEqual(5);
    expect(v.creatives).toHaveLength(2);
    const [first] = v.creatives;
    expect(first?.scenes[0]).toMatchObject({ number: 1, startSeconds: 0, visualSource: "generated_video", isGenerated: true });
    expect(first?.estimate?.incurred.simulated).toBe(true);
    expect(first?.estimate?.future.every((f) => f.category !== "video" || f.isPlaceholder)).toBe(true);
    expect(first?.canApprove).toBe(true);
    expect(v.costs.actual.planningBrl).toBeGreaterThan(0);
    expect(v.costs.projectedBrl).toBeCloseTo(v.costs.actual.totalBrl + v.costs.pendingFutureBrl, 2);
    expect(v.planning.simulated).toBe(true);
  });

  it("falha do Claude vira estado 'failed' com código tipado (ex.: rate limit) e permite tentar de novo", async () => {
    const { deps, planner } = await setup();
    const { campaignId } = ok(await startCampaignPlanning(deps, formInput()));
    vi.spyOn(console, "error").mockImplementation(() => {});
    planner.fail(new PlanningError("provider_error", "429", [], META, "rate_limited"));
    await settle();
    const v = await view(deps, campaignId);
    expect(v.state).toBe("failed");
    expect(v.error).toMatchObject({ code: "rate_limited", retryable: true, title: "Limite de requisições atingido" });
    expect(v.error?.detail).toContain("429");
  });

  it.each([
    [new PlanningError("retry_exhausted", "schema", [], META), "invalid_response"],
    [new PlanningError("provider_error", "t", [], META, "timeout"), "timeout"],
    [new PlanningError("stopped", "max_tokens", [], META), "stopped"],
    [new Error("boom"), "unknown"],
  ])("mapeia %s → %s", async (error, code) => {
    const { deps, planner } = await setup();
    const { campaignId } = ok(await startCampaignPlanning(deps, formInput()));
    vi.spyOn(console, "error").mockImplementation(() => {});
    planner.fail(error);
    await settle();
    expect((await view(deps, campaignId)).error?.code).toBe(code);
  });

  it("consultar o status repetidamente NÃO chama o planner de novo", async () => {
    const { deps, planner } = await setup();
    const { campaignId } = ok(await startCampaignPlanning(deps, formInput()));
    for (let i = 0; i < 5; i++) await getCampaignView(deps, campaignId);
    expect(planner.calls).toBe(1);
  });
});

describe("planejamento interrompido (restart do processo)", () => {
  it("campanha em 'planning' sem execução no processo é mostrada como interrompida, sem nova chamada", async () => {
    const storage = { store: new InMemoryPipelineStore(), ledger: new InMemoryCostLedger(), llmCallLog: new InMemoryLlmCallLog() };
    const first = await setup(storage);
    const { campaignId } = ok(await startCampaignPlanning(first.deps, formInput()));

    // "Restart": outro PipelineService sobre os mesmos dados; o primeiro nunca termina.
    const second = await setup(storage);
    const v = await view(second.deps, campaignId);
    expect(v.state).toBe("interrupted");
    expect(v.error).toMatchObject({ code: "interrupted", retryable: true });
    expect(second.planner.calls).toBe(0);

    // Retomar é explícito: uma nova execução, contada.
    ok(await retryCampaignPlanning(second.deps, campaignId));
    expect(second.planner.calls).toBe(1);
    expect((await view(second.deps, campaignId)).state).toBe("planning");
    second.planner.release();
    await settle();
    const done = await view(second.deps, campaignId);
    expect(done.state).toBe("planned");
    expect(done.planning.runs).toBe(2);
  });

  it("execução antiga que termina depois da retomada só registra custo; não sobrescreve o plano", async () => {
    const storage = { store: new InMemoryPipelineStore(), ledger: new InMemoryCostLedger(), llmCallLog: new InMemoryLlmCallLog() };
    // IDs compartilhados: em produção são UUIDs; aqui evitam colisão entre os dois "processos".
    const ids = sequentialIds();
    const first = await setup(storage, ids);
    const { campaignId } = ok(await startCampaignPlanning(first.deps, formInput()));
    const second = await setup(storage, ids);
    ok(await retryCampaignPlanning(second.deps, campaignId));

    vi.spyOn(console, "warn").mockImplementation(() => {});
    first.planner.release(); // execução antiga termina primeiro
    await settle();
    expect((await view(second.deps, campaignId)).state).toBe("planning");

    second.planner.release();
    await settle();
    const v = await view(second.deps, campaignId);
    expect(v.state).toBe("planned");
    // As duas execuções foram registradas (cada uma tem custo, mesmo simulado).
    expect(await storage.llmCallLog.list({ campaignId })).toHaveLength(2);
  });

  it("não permite replanejar enquanto o planejamento está em andamento neste processo", async () => {
    const { deps, planner } = await setup();
    const { campaignId } = ok(await startCampaignPlanning(deps, formInput()));
    const result = await retryCampaignPlanning(deps, campaignId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("planning_in_progress");
    expect(planner.calls).toBe(1);
  });
});

describe("aprovação (action)", () => {
  it("aprova a estimativa exibida e conclui com providers mock (sem MP4 real)", async () => {
    const { deps, view: v, campaignId } = await plannedCampaign();
    const creative = v.creatives[0]!;
    const result = ok(await approveCreative(deps, { jobId: creative.jobId!, estimateId: creative.estimate!.estimateId }));
    // A action volta logo; geração + render seguem em background no processo.
    expect(result).toEqual({ kind: "started" });
    await until(async () => (await view(deps, campaignId)).creatives[0]?.jobStatus === "completed");
    const after = (await view(deps, campaignId)).creatives[0]!;
    expect(after.jobStatus).toBe("completed");
    expect(after.result?.simulated).toBe(true);
    expect(after.actual?.simulated).toBe(true);
    expect(after.canApprove).toBe(false);
  });

  it("estimateId desatualizado é recusado sem mudar o estado do job", async () => {
    const { deps, view: v, campaignId } = await plannedCampaign();
    const creative = v.creatives[0]!;
    const result = await approveCreative(deps, { jobId: creative.jobId!, estimateId: "estimate_antiga" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("stale_estimate");
    expect((await view(deps, campaignId)).creatives[0]?.jobStatus).toBe("cost_estimated");
  });

  it("BUDGET_EXCEEDED sem permissão: diálogo sem 'Autorizar' e nada gerado", async () => {
    const { deps, h, view: v, campaignId } = await plannedCampaign({
      budget: { maxCostPerCreativeBrl: "3", maxCostPerCampaignBrl: "100", allowOverBudget: false },
    });
    const creative = v.creatives[0]!;
    const result = ok(await approveCreative(deps, { jobId: creative.jobId!, estimateId: creative.estimate!.estimateId }));
    expect(result.kind).toBe("budget_exceeded");
    if (result.kind !== "budget_exceeded") return;
    expect(result.source).toBe("approval");
    expect(result.decision).toMatchObject({ scope: "creative", limitBrl: 3, canAuthorize: false });
    expect(result.decision.excessBrl).toBeCloseTo(result.decision.projectedBrl - 3, 2);
    expect(h.video.generateCalls).toHaveLength(0);

    const persisted = (await view(deps, campaignId)).creatives[0]!;
    expect(persisted.budgetDecision?.source).toBe("approval");

    const forced = await approveCreative(deps, {
      jobId: creative.jobId!,
      estimateId: creative.estimate!.estimateId,
      authorizeOverBudget: true,
    });
    expect(forced.ok).toBe(false);
    if (!forced.ok) expect(forced.error.code).toBe("over_budget_not_allowed");
    expect(h.video.generateCalls).toHaveLength(0);
  });

  it("BUDGET_EXCEEDED com permissão: autorizar até o total mostrado e gerar", async () => {
    const { deps, h, view: v } = await plannedCampaign({
      budget: { maxCostPerCreativeBrl: "3", maxCostPerCampaignBrl: "100", allowOverBudget: true },
    });
    const creative = v.creatives[0]!;
    const first = ok(await approveCreative(deps, { jobId: creative.jobId!, estimateId: creative.estimate!.estimateId }));
    expect(first.kind === "budget_exceeded" && first.decision.canAuthorize).toBe(true);
    const second = ok(
      await approveCreative(deps, { jobId: creative.jobId!, estimateId: creative.estimate!.estimateId, authorizeOverBudget: true }),
    );
    expect(second).toEqual({ kind: "started" });
    await until(async () => (await h.store.getJob(creative.jobId!)).status === "completed");
    expect(h.video.generateCalls.length).toBeGreaterThan(0);
  });

  it("pausa por orçamento durante a geração: cancelar encerra o criativo", async () => {
    const { deps, h, view: v, campaignId } = await plannedCampaign();
    const creative = v.creatives[0]!;
    // Força a pausa: o job entra em budget_exceeded com decisão pendente.
    const job = await h.store.getJob(creative.jobId!);
    await h.store.saveJob({
      ...job,
      status: "budget_exceeded",
      pendingBudgetDecision: {
        kind: "BUDGET_EXCEEDED",
        scope: "campaign",
        currentCostBrl: 8,
        additionalEstimatedCostBrl: 9,
        newEstimatedTotalBrl: 17,
        budgetBrl: 15,
        canAuthorizeOverBudget: true,
      },
    });
    expect((await view(deps, campaignId)).creatives[0]?.budgetDecision?.source).toBe("generation");
    const result = ok(await resolveCreativeBudget(deps, { jobId: creative.jobId!, choice: "cancel" }));
    expect(result).toEqual({ kind: "cancelled" });
    expect((await view(deps, campaignId)).creatives[0]?.jobStatus).toBe("cancelled");
  });

  it("cancelar criativo antes de aprovar", async () => {
    const { deps, view: v, campaignId } = await plannedCampaign();
    ok(await cancelCreative(deps, v.creatives[0]!.jobId!));
    const after = (await view(deps, campaignId)).creatives[0]!;
    expect(after.jobStatus).toBe("cancelled");
    expect(after.canApprove).toBe(false);
    expect((await view(deps, campaignId)).costs.pendingFutureBrl).toBe(0);
  });
});

describe("histórico e dados corrompidos", () => {
  it("lista campanhas (mais recentes primeiro) e isola um arquivo corrompido", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "cf-data-"));
    const storage = {
      store: new FilePipelineStore(dataDir),
      ledger: new FileCostLedger(dataDir),
      llmCallLog: new FileLlmCallLog(dataDir),
    };
    const { deps, planner } = await setup(storage);
    const { campaignId } = ok(await startCampaignPlanning(deps, formInput()));
    planner.release();
    await until(async () => (await deps.service.getCampaign(campaignId)).status === "planned", 25_000);
    await mkdir(join(dataDir, "campaigns"), { recursive: true });
    await writeFile(join(dataDir, "campaigns", "campaign_bad.json"), "{ não é json");

    vi.spyOn(console, "error").mockImplementation(() => {});
    const entries = await listCampaigns(deps);
    expect(entries).toHaveLength(2);
    const good = entries.find((e) => e.ok);
    expect(good?.ok && good.item).toMatchObject({ id: campaignId, state: "planned", qualityLabel: "Econômico", simulated: true });
    const bad = entries.find((e) => !e.ok);
    expect(bad && !bad.ok && bad.error.code).toBe("corrupted");

    const opened = await getCampaignView(deps, "campaign_bad");
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.error.code).toBe("corrupted");
  }, 30_000); // I/O real com fsync: lento no Windows

  it("campanha inexistente → not_found", async () => {
    const { deps } = await setup();
    const result = await getCampaignView(deps, "campaign_nope");
    expect(!result.ok && result.error.code).toBe("not_found");
  });
});

describe("upload (action)", () => {
  it("gera productId quando o formulário ainda não tem um e recusa conteúdo que não é imagem", async () => {
    const { deps } = await setup();
    const okUpload = ok(
      await uploadProductImage(deps, { productId: null, file: { bytes: PNG_BYTES, size: PNG_BYTES.length, type: "image/png" } }),
    );
    expect(okUpload.productId).toMatch(/^prod_[0-9a-f-]{36}$/);
    const fake = new TextEncoder().encode("#!/bin/sh");
    const bad = await uploadProductImage(deps, { productId: okUpload.productId, file: { bytes: fake, size: fake.length, type: "image/png" } });
    expect(!bad.ok && bad.error.code).toBe("upload");
  });
});
