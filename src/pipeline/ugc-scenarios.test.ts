import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getCampaignView, type AppDeps } from "@/application/campaign-actions";
import { isUgcPersonSource } from "@/domain/ugc";
import { FileCostLedger } from "@/storage/file-cost-ledger";
import { LocalUploadStore } from "@/storage/upload-store";
import { ugcHarness } from "@/test/ugc-harness";
import { activeAttempt } from "./guards";
import { generateUgcScene, UgcReferenceRequiredError } from "./ugc-flow";
import { MockUgcVideoProvider } from "@/providers/ugc/mock-ugc-providers";
import { StaticPricingCatalog } from "@/costs/pricing-catalog";
import { PRICING_TABLE } from "@/config/pricing";
import { UGC_PRICING_REFS } from "@/config/ugc-models";

const videoPricing = new StaticPricingCatalog(PRICING_TABLE).requireOne(UGC_PRICING_REFS.high.video);

async function pausedAtReference(options: Parameters<typeof ugcHarness>[0] = {}) {
  const h = await ugcHarness(options);
  const outcome = await h.run();
  expect(outcome.kind).toBe("WAITING_STAGE");
  const job = await h.service.getJob(h.jobId);
  return { ...h, job, reference: job.ugc!.references.at(-1)! };
}

describe("AI UGC — bloqueio sem referência aprovada", () => {
  it("a cotação das cenas UGC fica bloqueada e o fluxo direto recusa sem enviar nada", async () => {
    const h = await pausedAtReference();
    const quote = await h.service.quoteStage(h.jobId, "ugc_video");
    expect(quote.ready).toBe(false);
    expect(quote.blocked).toMatch(/referência aprovada/);
    const provider = new MockUgcVideoProvider(videoPricing);
    const campaign = await h.service.getCampaign(h.campaign.id);
    const plan = campaign.plan!.creatives[0]!;
    const scene = plan.scenes.find((s) => isUgcPersonSource(s.visualSource))!;
    await expect(generateUgcScene({ store: {} as never, ledger: {} as never, audioAssets: {} as never, slicer: async () => new Uint8Array(), pollOptions: { maxPolls: 1, intervalMs: 0, sleep: async () => {} }, clock: () => "t", ids: (p) => p },
      { campaign, plan, job: h.job, scene, provider, exchangeRate: 5 })).rejects.toBeInstanceOf(UgcReferenceRequiredError);
    expect(provider.calls).toHaveLength(0);
    expect(h.calls.videos()).toHaveLength(0);
  });
});

describe("AI UGC — gerar outra referência, trocar apresentador/ambiente", () => {
  it("gerar outra: nova versão, anterior descartada, custo de cada tentativa no ledger, continua no mesmo teto", async () => {
    const h = await pausedAtReference();
    const again = await h.service.regenerateUgcReference(h.jobId);
    expect(again.resumed).toBe(true);
    expect((await again.completion!).kind).toBe("WAITING_STAGE");
    const job = await h.service.getJob(h.jobId);
    expect(job.ugc!.references.map((r) => [r.version, r.review])).toEqual([["v1", "rejected"], ["v2", "pending"]]);
    const entries = (await new FileCostLedger(h.config.dataDir).list({ jobId: h.jobId })).filter((e) => e.category === "ugc_reference");
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.simulated)).toBe(true);
    expect(h.calls.videos()).toHaveLength(0);
    // A referência v1 não pode mais ser aprovada.
    await expect(h.service.approveUgcReference(h.jobId, h.reference.id)).rejects.toThrow(/mais recente/);
  });

  it("trocar apresentador e ambiente cria nova revisão da identidade e exige nova referência", async () => {
    const h = await pausedAtReference();
    const changed = await h.service.updateUgcIdentity(h.jobId, { presenter: "man", environment: "workshop" });
    expect(changed.resumed).toBe(true);
    await changed.completion;
    const job = await h.service.getJob(h.jobId);
    expect(job.ugc!.identity).toMatchObject({ gender: "man", environment: "workshop", revision: 2 });
    expect(job.ugc!.references[0]!.review).toBe("rejected");
    expect(job.ugc!.references[1]).toMatchObject({ identityRevision: 2, review: "pending" });
    expect(h.calls.references()[1]!.identity.gender).toBe("man");
    await expect(h.service.approveUgcReference(h.jobId, job.ugc!.references[0]!.id)).rejects.toThrow();
  });

  it("depois que existem cenas UGC, trocar a pessoa é recusado (consistência)", async () => {
    const h = await pausedAtReference();
    await (await h.service.approveUgcReference(h.jobId, h.reference.id)).completion;
    await expect(h.service.updateUgcIdentity(h.jobId, { presenter: "man" })).rejects.toThrow(/cópia/);
    await expect(h.service.regenerateUgcReference(h.jobId)).rejects.toThrow(/cópia/);
  });
});

describe("AI UGC — retomada e incerteza", () => {
  it("reinício do processo durante a pausa: aprovar na nova instância continua e conclui", async () => {
    const h = await pausedAtReference();
    const restarted = h.build();
    const result = await restarted.approveUgcReference(h.jobId, h.reference.id);
    expect(result.resumed).toBe(true);
    expect((await result.completion!).kind).toBe("COMPLETED");
    expect(h.calls.references()).toHaveLength(1);
  });

  it("referência enviada sem ID confirmado nunca é reenviada", async () => {
    const h = await ugcHarness();
    const job = await h.service.getJob(h.jobId);
    const store = (h.service as unknown as { deps: { store: { saveJob(j: unknown): Promise<void> } } }).deps.store;
    await store.saveJob({ ...job, ugc: { ...job.ugc!, references: [{ id: "ugcref_x", version: "v1", state: "submitting", review: "pending", identityId: job.ugc!.identity.id, identityRevision: 1, provider: "google", model: "m", isMock: false, prompt: "p", product: job.ugc!.product, estimatedCostUsd: 0.04, createdAt: "t" }] } });
    const quote = await h.service.quoteStage(h.jobId, "ugc_reference");
    expect(quote.ready).toBe(false);
    expect(quote.blocked).toMatch(/incerto/);
    const outcome = await h.run();
    expect(outcome.kind).toBe("WAITING_STAGE");
    expect(h.calls.references()).toHaveLength(0);
  });
});

describe("AI UGC — orçamento e autorização", () => {
  it("teto acima do orçamento: nada é autorizado nem chamado", async () => {
    const h = await ugcHarness({ modes: { ugc_reference: "real" }, realReference: true, request: { budget: { maxCostPerCreativeBrl: 0.01, maxCostPerCampaignBrl: 100, allowOverBudget: false } } });
    const quote = await h.service.quoteJob(h.jobId);
    await expect(h.service.authorizeAndRunJob(h.jobId, quote.token)).rejects.toThrow(/orçamento/);
    expect(h.calls.references()).toHaveLength(0);
  });

  it("referência 'real' (transporte falso) registra custo NÃO simulado na categoria de referência e salva versão", async () => {
    // Teto conservador: com etapa REAL, reserva o futuro inteiro (preços UGC provisórios).
    const h = await pausedAtReference({ modes: { ugc_reference: "real" }, realReference: true, request: { budget: { maxCostPerCreativeBrl: 100, maxCostPerCampaignBrl: 200, allowOverBudget: false } } });
    const entries = (await new FileCostLedger(h.config.dataDir).list({ jobId: h.jobId })).filter((e) => e.category === "ugc_reference");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ simulated: false, operation: "ugc_reference_generation", attemptId: h.reference.id });
    expect(h.reference.imageUri).toMatch(/\/v1\/reference\.png$/);
    expect(h.ugcAssets.saved).toHaveLength(1);
  });

  it("sem autorização, gerar outra referência ou trocar a pessoa não chama provider", async () => {
    const h = await ugcHarness();
    const regenerate = await h.service.regenerateUgcReference(h.jobId);
    expect(regenerate.resumed).toBe(false); // sem autorização ativa: só registra a intenção, não gera
    const changed = await h.service.updateUgcIdentity(h.jobId, { environment: "kitchen" });
    expect(changed.resumed).toBe(false);
    expect(h.calls.references()).toHaveLength(0);
  });
});

describe("AI UGC — estratégia de áudio externa (ElevenLabs + lip sync)", () => {
  it("narração uma vez, trechos por cena para o lip sync, clipes mudos e narração única no render", async () => {
    const h = await pausedAtReference({ strategy: "external_lipsync" });
    expect(h.job.ugc!.audioStrategy).toBe("external_lipsync");
    expect(h.calls.narrations()).toHaveLength(0); // narração vem DEPOIS da aprovação
    await (await h.service.approveUgcReference(h.jobId, h.reference.id)).completion;
    expect(h.calls.narrations()).toHaveLength(1);
    for (const call of h.calls.videos()) {
      expect(call.audio).toBeDefined();
      expect(call.audio!.endSeconds).toBeGreaterThan(call.audio!.startSeconds);
    }
    const job = await h.service.getJob(h.jobId);
    expect(job.manifest!.assets.some((a) => a.clipAudio)).toBe(false);
    expect(job.manifest!.audio).toHaveLength(1);
  });
});

describe("AI UGC × Presenter — rotas separadas", () => {
  it("projeto com Presenter não cria estado nem chama providers UGC", async () => {
    const h = await ugcHarness({ request: { creativeMode: "standard", ugc: undefined, presenterPresetId: "influencer", quality: "economy" } });
    const job = await h.service.getJob(h.jobId);
    expect(job.ugc).toBeUndefined();
    expect((await h.service.quoteStage(h.jobId, "ugc_reference")).done).toBe(true);
    expect((await h.service.quoteStage(h.jobId, "ugc_video")).done).toBe(true);
    expect((await h.run()).kind).toBe("COMPLETED");
    expect(h.calls.references()).toHaveLength(0);
    expect(h.calls.videos()).toHaveLength(0);
  });

  it("projeto AI UGC sem foto do produto é recusado antes de qualquer custo", async () => {
    await expect(ugcHarness({ request: { product: { id: "p", name: "X", description: "d", features: [], benefits: [], images: [] } } })).rejects.toThrow(/foto real/);
  });
});

describe("AI UGC — storyboard na interface", () => {
  it("mostra quem aparece, o que segura, o que fala e o que faz, e o painel de aprovação", async () => {
    const h = await pausedAtReference();
    const uploads = new LocalUploadStore(await mkdtemp(join(tmpdir(), "ugc-up-")));
    const deps: AppDeps = { service: h.service, uploads, rendersDir: h.config.rendersDir, audioDir: h.config.audioDir };
    const result = await getCampaignView(deps, h.campaign.id);
    if (!result.ok) throw new Error("view");
    const creative = result.value.creatives[0]!;
    expect(creative.ugc).toMatchObject({ headline: "Esta será a pessoa apresentando seu produto", awaitingApproval: true, canApprove: true, canChangeIdentity: true });
    expect(creative.ugc!.current).toMatchObject({ isMock: true, review: "pending" });
    expect(creative.nextAction?.stage).toBe("ugc_reference");
    const hook = creative.scenes[0]!;
    expect(hook.ugc).toMatchObject({ holding: "Garrafa Térmica X" });
    expect(hook.ugc!.who).toMatch(/mesma apresentadora/i);
    expect(hook.narration.length).toBeGreaterThan(0);
    expect(hook.ugc!.action.length).toBeGreaterThan(0);
    const broll = creative.scenes.find((s) => s.visualSource === "product_broll");
    expect(broll?.ugc?.who).toMatch(/só o produto/);
    expect(creative.workflow?.find((w) => w.id === "ugc_reference")?.state).toBe("paused");
  });
});

describe("AI UGC — storyboard editável antes das cenas", () => {
  it("valida tipo, fala nativa e frases proibidas; edição invalida a autorização", async () => {
    const h = await ugcHarness();
    const plan = (await h.service.getCampaign(h.campaign.id)).plan!.creatives[0]!;
    const hook = plan.scenes[0]!;
    const broll = plan.scenes.find((s) => s.visualSource === "product_broll")!;
    await expect(h.service.updateStoryboardScene(h.jobId, { sceneId: hook.id, narration: "Testei por uma semana e amei.", visualDescription: "x", visualSource: "ugc_hook" })).rejects.toThrow(/não permitida/);
    await expect(h.service.updateStoryboardScene(h.jobId, { sceneId: broll.id, narration: "Fala no B-roll", visualDescription: "x", visualSource: "product_broll" })).rejects.toThrow(/fala nativa/);
    await expect(h.service.updateStoryboardScene(h.jobId, { sceneId: hook.id, narration: "Olha isso", visualDescription: "x", visualSource: "presenter" })).rejects.toThrow(/AI UGC/);
    const edited = await h.service.updateStoryboardScene(h.jobId, { sceneId: hook.id, narration: "Olha isso aqui: repara no acabamento.", visualDescription: "Segura o produto perto do rosto", visualSource: "ugc_hook" });
    expect(edited.jobAuthorization).toBeUndefined();
    expect(activeAttempt(edited.audioAttempts)).toBeUndefined();
  });
});
