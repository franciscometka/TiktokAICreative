import { describe, expect, it } from "vitest";
import { loadAppConfig } from "@/config/env";
import { googleUgcReadiness } from "@/config/ugc-readiness";
import { isUgcPersonSource } from "@/domain/ugc";
import { createUgcProviderFactories } from "@/providers/ugc";
import { FileCostLedger } from "@/storage/file-cost-ledger";
import { FAKE_GOOGLE_KEY, googleFake, PNG_1X1, type GoogleFakeOptions } from "@/test/google-fake";
import { makeMp4 } from "@/test/mp4-fixture";
import { ugcHarness } from "@/test/ugc-harness";
import { activeAttempt } from "./guards";
import { generateUgcReference, UgcCostChangedError } from "./ugc-flow";

const env = { GOOGLE_AI_API_KEY: FAKE_GOOGLE_KEY, UGC_PROVIDER: "google", UGC_REAL_ALLOWED: "true" };
const budget = { maxCostPerCreativeBrl: 100, maxCostPerCampaignBrl: 200, allowOverBudget: false };

/** Pipeline híbrido completo com os providers Google REAIS sobre um fetch falso (sem rede). */
async function googleHarness(options: GoogleFakeOptions = {}, video = false) {
  const fake = googleFake(options);
  const ugcProviders = createUgcProviderFactories({ google: {
    apiKey: FAKE_GOOGLE_KEY, readiness: googleUgcReadiness(loadAppConfig(env), env), transport: fake.fetch,
    loadImage: async () => ({ data: new Uint8Array(PNG_1X1), mimeType: "image/png" }),
  } });
  const h = await ugcHarness({ modes: { ugc_reference: "real", ...(video ? { ugc_video: "real" as const } : {}) }, ugcProviders, request: { budget } });
  const ledger = () => new FileCostLedger(h.config.dataDir).list({ jobId: h.jobId });
  const job = () => h.service.getJob(h.jobId);
  return { ...h, fake, options, ledger, job };
}

async function approvedReference(options: GoogleFakeOptions = {}) {
  const h = await googleHarness(options, true);
  expect((await h.run()).kind).toBe("WAITING_STAGE");
  const reference = (await h.job()).ugc!.references.at(-1)!;
  return { ...h, approve: () => h.service.approveUgcReference(h.jobId, reference.id, { fidelityConfirmed: true }) };
}

describe("referência Gemini REAL (fetch falso)", () => {
  it("sucesso: um envio, custo real no ledger, metadata persistida e pausa para aprovação visual", async () => {
    const h = await googleHarness();
    expect((await h.run()).kind).toBe("WAITING_STAGE");
    const job = await h.job();
    const reference = job.ugc!.references.at(-1)!;
    expect(h.fake.posts()).toBe(1);
    expect(reference).toMatchObject({ state: "succeeded", review: "pending", provider: "google", model: "gemini-3.1-flash-image", isMock: false, requestId: "req_img", metadata: { promptTokens: 300, outputTokens: 1290 } });
    expect(reference.inputHash).toMatch(/^[0-9a-f]{32}$/);
    expect(reference.maxApprovedCostUsd).toBeCloseTo(0.067, 6);
    expect(reference.actualCostUsd).toBeCloseTo(0.067, 6);
    const entries = (await h.ledger()).filter(e => e.category === "ugc_reference");
    expect(entries).toEqual([expect.objectContaining({ simulated: false, costUsd: 0.067 })]);
    expect(h.calls.videos()).toHaveLength(0); // nenhuma cena antes da aprovação
    expect(job.waitingForStage).toBe("ugc_reference");
  });

  it("intenção 'submitting' com hash já está gravada quando o POST sai", async () => {
    let seen: { state: string; inputHash?: string } | undefined;
    const fake = googleFake();
    const reader: { job?: () => Promise<{ ugc?: { references: { state: string; inputHash?: string }[] } }> } = {};
    const ugcProviders = createUgcProviderFactories({ google: {
      apiKey: FAKE_GOOGLE_KEY, readiness: googleUgcReadiness(loadAppConfig(env), env), loadImage: async () => ({ data: new Uint8Array(PNG_1X1), mimeType: "image/png" }),
      transport: async (input, init) => { if (init?.method === "POST") seen = (await reader.job!()).ugc!.references.at(-1); return fake.fetch(input, init); },
    } });
    const h = await ugcHarness({ modes: { ugc_reference: "real" }, ugcProviders, request: { budget } });
    reader.job = () => h.service.getJob(h.jobId);
    await h.run();
    expect(seen).toMatchObject({ state: "submitting" });
    expect(seen?.inputHash).toMatch(/^[0-9a-f]{32}$/);
  });

  it("A) rejeição 400: referência falha, sem custo, sem segredo, sem novo envio", async () => {
    const h = await googleHarness({ image: "rejected" });
    const outcome = await h.run();
    expect(outcome.kind).toBe("FAILED");
    const reference = (await h.job()).ugc!.references.at(-1)!;
    expect(reference).toMatchObject({ state: "failed", diagnostic: { billing: "rejected", operation: "none", httpStatus: 400 } });
    expect(JSON.stringify(await h.job())).not.toContain(FAKE_GOOGLE_KEY);
    expect(await h.ledger()).toHaveLength(0);
    expect(h.fake.posts()).toBe(1);
  });

  it("C) resposta perdida (rede após envio): uncertain, cotação bloqueada, nunca reenvia", async () => {
    const h = await googleHarness({ image: "network" });
    expect((await h.run()).kind).toBe("WAITING_STAGE");
    const reference = (await h.job()).ugc!.references.at(-1)!;
    expect(reference.state).toBe("uncertain");
    expect(reference.error).not.toContain(FAKE_GOOGLE_KEY);
    const quote = await h.service.quoteStage(h.jobId, "ugc_reference");
    expect(quote.ready).toBe(false);
    expect(quote.blocked).toMatch(/incerto/);
    expect((await h.run()).kind).toBe("WAITING_STAGE");
    expect(h.fake.posts()).toBe(1);
  });

  it("teto: custo recalculado acima do aprovado pausa sem rede", async () => {
    const h = await googleHarness();
    const campaign = await h.service.getCampaign(h.campaign.id);
    const factories = createUgcProviderFactories({ google: { apiKey: FAKE_GOOGLE_KEY, readiness: googleUgcReadiness(loadAppConfig(env), env), loadImage: async () => ({ data: new Uint8Array(PNG_1X1), mimeType: "image/png" }), transport: h.fake.fetch } });
    const pricing = (await import("@/costs/pricing-catalog")).StaticPricingCatalog;
    const table = (await import("@/config/pricing")).PRICING_TABLE;
    const provider = factories.reference(new pricing(table).requireOne({ provider: "google", model: "gemini-3.1-flash-image" }), "real");
    const deps = (h.service as unknown as { ugcDeps(): Parameters<typeof generateUgcReference>[0] }).ugcDeps();
    await expect(generateUgcReference(deps, { campaign, plan: campaign.plan!.creatives[0]!, job: await (async () => { const j = await h.job(); return { ...j, status: "generating" as const, approval: { estimateId: j.estimate!.id, approvedTotalBrl: 999, overBudget: false, approvedAt: "t" } }; })(), provider, exchangeRate: 5, maxCostUsd: 0.01 })).rejects.toBeInstanceOf(UgcCostChangedError);
    expect(h.fake.posts()).toBe(0);
  });

  it("orçamento do job insuficiente: nada é autorizado nem enviado", async () => {
    const fake = googleFake();
    const ugcProviders = createUgcProviderFactories({ google: { apiKey: FAKE_GOOGLE_KEY, readiness: googleUgcReadiness(loadAppConfig(env), env), loadImage: async () => ({ data: new Uint8Array(PNG_1X1), mimeType: "image/png" }), transport: fake.fetch } });
    const h = await ugcHarness({ modes: { ugc_reference: "real" }, ugcProviders, request: { budget: { maxCostPerCreativeBrl: 0.01, maxCostPerCampaignBrl: 100, allowOverBudget: false } } });
    const quote = await h.service.quoteJob(h.jobId);
    await expect(h.service.authorizeAndRunJob(h.jobId, quote.token)).rejects.toThrow(/orçamento/);
    expect(fake.calls).toHaveLength(0);
  });

  it("gerar outra: v2 nova, v1 preservada; cada tentativa custa e fica no ledger", async () => {
    const h = await googleHarness();
    await h.run();
    const again = await h.service.regenerateUgcReference(h.jobId);
    await again.completion;
    const references = (await h.job()).ugc!.references;
    expect(references.map(r => [r.version, r.state, r.review])).toEqual([["v1", "succeeded", "rejected"], ["v2", "succeeded", "pending"]]);
    expect(h.ugcAssets.saved).toHaveLength(2);
    expect((await h.ledger()).filter(e => e.category === "ugc_reference")).toHaveLength(2);
    expect(h.fake.posts()).toBe(2);
  });
});

describe("cena Veo REAL (fetch falso)", () => {
  it("após aprovação: submit → operation ID → polling → download; áudio nativo, sem ElevenLabs, duração real", async () => {
    const h = await approvedReference();
    const resumed = await h.approve();
    expect((await resumed.completion!).kind).not.toBe("FAILED");
    const job = await h.job();
    const ugcScenes = (await h.service.getCampaign(h.campaign.id)).plan!.creatives[0]!.scenes.filter(s => isUgcPersonSource(s.visualSource));
    const veoPosts = h.fake.calls.filter(c => c.method === "POST" && c.url.includes("predictLongRunning"));
    expect(veoPosts.length).toBe(ugcScenes.length); // um POST por cena, nenhum retry
    expect(h.calls.narrations()).toHaveLength(0);
    const operation = job.ugcVideoOperations![0]!;
    expect(operation).toMatchObject({ state: "settled", outcome: "succeeded", providerOperationId: expect.stringContaining("operations/"), stage: "ugc_video", jobId: h.jobId, requestedDurationSeconds: 8 });
    expect(operation.inputHash).toMatch(/^[0-9a-f]{32}$/);
    const attempt = activeAttempt(job.scenes.find(s => s.sceneId === ugcScenes[0]!.id)!.attempts)!;
    expect(attempt).toMatchObject({ isMock: false, status: "succeeded", ugc: { clipHasAudio: true, audioStrategy: "native_speech" } });
    expect(attempt.media).toMatchObject({ status: "valid", requestedDurationSeconds: 8, actualMediaDurationSeconds: 8 });
    expect(attempt.assetUri).toMatch(/\/v1\/clip\.mp4$/);
    const scenes = (await h.ledger()).filter(e => e.category === "ugc_scene");
    expect(scenes[0]).toMatchObject({ simulated: false, quantity: 8, costUsd: 0.8 });
    // Render: só os clipes UGC tocam o próprio áudio; nenhuma narração por cima.
    const manifest = h.renderer.renderCalls.at(-1)!;
    expect(manifest.audio.filter(a => a.kind === "narration" && !a.isMock)).toHaveLength(0);
    expect(manifest.assets.filter(a => a.clipAudio).length).toBe(ugcScenes.length);
  });

  it("reinício após submit: polling expira, novo processo retoma pelo operation ID sem novo POST", { timeout: 20_000 }, async () => {
    const h = await approvedReference({ veoRunningPolls: Infinity });
    const first = await h.approve();
    expect((await first.completion!).kind).toBe("WAITING_STAGE");
    const pending = (await h.job()).ugcVideoOperations!.at(-1)!;
    expect(pending).toMatchObject({ state: "pending", providerOperationId: expect.stringContaining("operations/") });
    const postsBefore = h.fake.posts();
    h.options.veoRunningPolls = 0;
    const restarted = h.build();
    const quote = await restarted.quoteStage(h.jobId, "ugc_video");
    expect(quote.unit).toContain(":resume:");
    const job = await restarted.quoteJob(h.jobId);
    await (await restarted.authorizeAndRunJob(h.jobId, job.token)).completion;
    const settled = (await h.job()).ugcVideoOperations!.find(o => o.attemptId === pending.attemptId)!;
    expect(settled).toMatchObject({ state: "settled", outcome: "succeeded" });
    // A cena retomada não gerou POST; só as cenas seguintes (uma por cena) enviaram.
    const retomadaPosts = h.fake.posts() - postsBefore;
    const ugcScenes = (await h.service.getCampaign(h.campaign.id)).plan!.creatives[0]!.scenes.filter(s => isUgcPersonSource(s.visualSource)).length;
    expect(retomadaPosts).toBe(ugcScenes - 1);
    expect((await h.ledger()).filter(e => e.attemptId === pending.attemptId)).toHaveLength(1);
  });

  it("C) rede no submit: operação uncertain sem ID, cotação bloqueada, sem reenvio", async () => {
    const h = await approvedReference({ veoSubmit: "network" });
    expect((await (await h.approve()).completion!).kind).toBe("WAITING_STAGE");
    const operation = (await h.job()).ugcVideoOperations!.at(-1)!;
    expect(operation).toMatchObject({ state: "uncertain" });
    expect(operation.providerOperationId).toBeUndefined();
    expect((await h.service.quoteStage(h.jobId, "ugc_video")).blocked).toMatch(/incerto/);
    expect(h.fake.calls.filter(c => c.url.includes("predictLongRunning"))).toHaveLength(1);
  });

  it("B) operação criada que falha: settled/failed, possível cobrança, sem retry", async () => {
    const h = await approvedReference({ veoOutcome: "error" });
    expect((await (await h.approve()).completion!).kind).toBe("FAILED");
    const operation = (await h.job()).ugcVideoOperations!.at(-1)!;
    expect(operation).toMatchObject({ state: "settled", outcome: "failed", diagnostic: { operation: "created" } });
    expect(h.fake.calls.filter(c => c.url.includes("predictLongRunning"))).toHaveLength(1);
    expect((await h.ledger()).filter(e => e.category === "ugc_scene")).toHaveLength(0);
  });

  it("asset inválido (duração errada) e MP4 sem áudio: custo preservado, versão rejeitada não fica ativa", async () => {
    for (const clip of [makeMp4(3, { audioTrack: true }), makeMp4(8)]) {
      const h = await approvedReference({ clip });
      expect((await (await h.approve()).completion!).kind).toBe("FAILED");
      const job = await h.job();
      const attempt = job.scenes.flatMap(s => s.attempts).find(a => a.ugc)!;
      expect(attempt).toMatchObject({ status: "failed", active: false, rejectedAssetUri: expect.stringMatching(/\/v1\/clip\.mp4$/) });
      expect((await h.ledger()).filter(e => e.category === "ugc_scene")).toEqual([expect.objectContaining({ costUsd: 0.8, simulated: false })]);
      expect(job.ugcVideoOperations!.at(-1)).toMatchObject({ state: "settled", outcome: "invalid_media" });
      expect(h.fake.calls.filter(c => c.url.includes("predictLongRunning"))).toHaveLength(1);
    }
  });
});
