import { describe, expect, it } from "vitest";
import { loadAppConfig } from "@/config/env";
import { kreaRequestedDuration, kreaUgcPricingRefs } from "@/config/krea-ugc-models";
import { kreaUgcReadiness } from "@/config/krea-ugc-readiness";
import { isUgcPersonSource } from "@/domain/ugc";
import { createUgcProviderFactories } from "@/providers/ugc";
import { FileCostLedger } from "@/storage/file-cost-ledger";
import { PNG_1X1 } from "@/test/google-fake";
import { FAKE_KREA_KEY, kreaFake, type KreaFakeOptions } from "@/test/krea-fake";
import { ugcHarness } from "@/test/ugc-harness";
import { activeAttempt } from "./guards";
import { hybridCapabilities } from "./hybrid-service";

const env = { KREA_API_KEY: FAKE_KREA_KEY, UGC_PROVIDER: "krea", UGC_REAL_ALLOWED: "true" };
const budget = { maxCostPerCreativeBrl: 100, maxCostPerCampaignBrl: 200, allowOverBudget: false };

/** Pipeline híbrido com os providers Krea REAIS sobre um fetch falso (sem rede, sem custo). */
async function kreaHarness(options: KreaFakeOptions = {}, video = false) {
  const fake = kreaFake(options);
  const ugcProviders = createUgcProviderFactories({ krea: {
    apiKey: FAKE_KREA_KEY, readiness: kreaUgcReadiness(loadAppConfig(env), env), transport: fake.fetch,
    loadImage: async () => ({ data: new Uint8Array(PNG_1X1), mimeType: "image/png" }),
  } });
  const h = await ugcHarness({ modes: { ugc_reference: "real", ...(video ? { ugc_video: "real" as const } : {}) }, ugcProviders, deps: { ugcChoice: kreaUgcPricingRefs }, request: { budget } });
  const ledger = () => new FileCostLedger(h.config.dataDir).list({ jobId: h.jobId });
  const job = () => h.service.getJob(h.jobId);
  return { ...h, fake, options, ledger, job };
}

describe("AI UGC via Krea no pipeline (fetch falso)", () => {
  it("capabilities apontam Krea só com preflight Krea completo", () => {
    expect(hybridCapabilities(loadAppConfig(env), env).ugc_reference).toMatchObject({ available: true, provider: "krea" });
    expect(hybridCapabilities(loadAppConfig({ UGC_PROVIDER: "krea" }), { KREA_API_KEY: FAKE_KREA_KEY }).ugc_video).toMatchObject({ available: false, provider: "krea" });
    expect(hybridCapabilities(loadAppConfig({}), {}).ugc_video.provider).toBe("google");
  });

  it("projeto novo fixa preços Krea; referência: um POST pago, custo real no ledger, pausa para aprovação", async () => {
    const h = await kreaHarness();
    const campaign = await h.service.getCampaign(h.campaign.id);
    expect(campaign.settings.ugc).toEqual(kreaUgcPricingRefs("high"));
    expect((await h.run()).kind).toBe("WAITING_STAGE");
    const reference = (await h.job()).ugc!.references.at(-1)!;
    expect(reference).toMatchObject({ state: "succeeded", review: "pending", provider: "krea", model: "nano-banana-2", isMock: false });
    expect(h.fake.posts("image")).toBe(1);
    expect((await h.ledger()).filter(e => e.category === "ugc_reference")).toEqual([expect.objectContaining({ simulated: false, costUsd: 0.08 })]);
    expect(JSON.stringify(await h.job())).not.toContain(FAKE_KREA_KEY);
  });

  it("após aprovação: uma cena Veo por POST, áudio nativo, sem ElevenLabs, custo pela duração comprada", async () => {
    const h = await kreaHarness({}, true);
    expect((await h.run()).kind).toBe("WAITING_STAGE");
    const reference = (await h.job()).ugc!.references.at(-1)!;
    const resumed = await h.service.approveUgcReference(h.jobId, reference.id);
    const outcome = await resumed.completion!;
    expect(outcome.kind).not.toBe("FAILED");
    const job = await h.job();
    const ugcScenes = (await h.service.getCampaign(h.campaign.id)).plan!.creatives[0]!.scenes.filter(s => isUgcPersonSource(s.visualSource));
    expect(h.fake.posts("video")).toBe(ugcScenes.length);
    expect(h.calls.narrations()).toHaveLength(0);
    const attempt = activeAttempt(job.scenes.find(s => s.sceneId === ugcScenes[0]!.id)!.attempts)!;
    expect(attempt).toMatchObject({ isMock: false, status: "succeeded", ugc: { clipHasAudio: true, audioStrategy: "native_speech" } });
    // Estimativa e custo real usam a duração COMPRADA (4/6/8s), não a editorial.
    const bought = kreaRequestedDuration(ugcScenes[0]!.estimatedGenerationSeconds);
    expect(job.estimate!.breakdown.filter(b => b.category === "ugc_scene").every(b => [4, 6, 8].includes(b.quantity))).toBe(true);
    expect(attempt.media).toMatchObject({ status: "valid", requestedDurationSeconds: bought, actualMediaDurationSeconds: bought });
    const scene = (await h.ledger()).filter(e => e.category === "ugc_scene")[0]!;
    expect(scene).toMatchObject({ simulated: false, quantity: bought });
    expect(scene.costUsd).toBeCloseTo(bought * 0.1, 6);
    expect(job.stageApprovals!.filter(a => a.stage.startsWith("ugc_")).every(a => a.provider === "krea")).toBe(true);
  });

  it("400 na criação: referência falha sem custo, sem segredo, sem reenvio", async () => {
    const h = await kreaHarness({ create: "rejected" });
    expect((await h.run()).kind).toBe("FAILED");
    expect((await h.job()).ugc!.references.at(-1)).toMatchObject({ state: "failed", diagnostic: { billing: "rejected", operation: "none" } });
    expect(JSON.stringify(await h.job())).not.toContain(FAKE_KREA_KEY);
    expect(await h.ledger()).toHaveLength(0);
    expect(h.fake.posts()).toBe(1);
  });

  it("rede após envio: uncertain, cotação bloqueada, nunca reenvia", async () => {
    const h = await kreaHarness({ create: "network" });
    expect((await h.run()).kind).toBe("WAITING_STAGE");
    expect((await h.job()).ugc!.references.at(-1)!.state).toBe("uncertain");
    expect((await h.service.quoteStage(h.jobId, "ugc_reference")).blocked).toMatch(/incerto/);
    expect((await h.run()).kind).toBe("WAITING_STAGE");
    expect(h.fake.posts()).toBe(1);
  });
});
