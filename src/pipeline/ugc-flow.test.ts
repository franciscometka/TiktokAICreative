import { describe, expect, it } from "vitest";
import { isUgcPersonSource } from "@/domain/ugc";
import { activeAttempt } from "./guards";
import { ugcHarness, FULL_REVIEW } from "@/test/ugc-harness";
import { MockUgcReferenceProvider, MockUgcVideoProvider } from "@/providers/ugc/mock-ugc-providers";

describe("AI UGC — pipeline MOCK completo, offline", () => {
  it("referência → pausa para aprovação → cenas UGC com a mesma pessoa → B-roll → render", async () => {
    const h = await ugcHarness();
    const planned = await h.service.getJob(h.jobId);
    expect(planned.ugc?.identity).toMatchObject({ gender: "woman", revision: 1, source: "generated" });
    expect(planned.ugc?.audioStrategy).toBe("native_speech");
    const plan = (await h.service.getCampaign(h.campaign.id)).plan!.creatives[0]!;
    expect(plan.scenes[0]!.visualSource).toBe("ugc_hook");
    expect(plan.scenes.some((s) => s.visualSource === "ugc_cta")).toBe(true);

    // Nada foi chamado antes da autorização.
    expect(h.calls.references()).toHaveLength(0);
    const first = await h.run();
    expect(first.kind).toBe("WAITING_STAGE");
    let job = await h.service.getJob(h.jobId);
    expect(job.jobAuthorization).toMatchObject({ status: "paused" });
    expect(job.waitingForStage).toBe("ugc_reference");
    expect(job.ugc!.references).toHaveLength(1);
    expect(job.ugc!.references[0]).toMatchObject({ state: "succeeded", review: "pending", isMock: true, version: "v1" });
    // Nenhuma cena UGC antes da aprovação.
    expect(h.calls.references()).toHaveLength(1);
    expect(h.calls.videos()).toHaveLength(0);

    const approved = await h.service.approveUgcReference(h.jobId, job.ugc!.references[0]!.id, FULL_REVIEW);
    expect(approved.resumed).toBe(true);
    expect((await approved.completion!).kind).toBe("COMPLETED");
    job = await h.service.getJob(h.jobId);
    expect(job.jobAuthorization?.status).toBe("completed");

    const ugcScenes = plan.scenes.filter((s) => isUgcPersonSource(s.visualSource));
    expect(h.calls.videos()).toHaveLength(ugcScenes.length);
    // Consistência: mesma referência, mesma identidade, mesmo produto em TODAS as cenas UGC.
    const refId = job.ugc!.references[0]!.id;
    for (const call of h.calls.videos()) {
      expect(call.reference.id).toBe(refId);
      expect(call.identity.id).toBe(job.ugc!.identity.id);
      expect(call.product.imageId).toBe("img_1");
    }
    const attempts = ugcScenes.map((s) => activeAttempt(job.scenes.find((g) => g.sceneId === s.id)!.attempts)!);
    expect(new Set(attempts.map((a) => a.ugc!.referenceId)).size).toBe(1);
    expect(new Set(attempts.map((a) => a.ugc!.wardrobe)).size).toBe(1);
    expect(new Set(attempts.map((a) => a.ugc!.environment)).size).toBe(1);
    // B-roll do produto pelo VideoProvider genérico; Presenter nunca usado.
    expect(h.calls.productVideos().length).toBe(plan.scenes.filter((s) => s.visualSource === "product_broll").length);
    expect(h.calls.presenter()).toBe(0);
    // Fala nativa: nenhuma narração TTS; clipes UGC tocam o próprio áudio, sem narração por cima.
    expect(h.calls.narrations()).toHaveLength(0);
    expect(job.manifest!.audio).toEqual([]);
    for (const s of ugcScenes) expect(job.manifest!.assets.find((a) => a.sceneId === s.id)!.clipAudio).toBe(true);
  });

  it("retry de Product UGC deriva ugc_video e nunca chama Presenter", async () => {
    const videoOptions = { fail: true };
    const videos: MockUgcVideoProvider[] = [];
    const h = await ugcHarness({
      ugcProviders: {
        reference: pricing => new MockUgcReferenceProvider(pricing),
        video: pricing => {
          const provider = new MockUgcVideoProvider(pricing, "native_speech", videoOptions);
          videos.push(provider);
          return provider;
        },
      },
    });
    await h.run();
    let job = await h.service.getJob(h.jobId);
    const reference = job.ugc!.references[0]!;
    const approved = await h.service.approveUgcReference(h.jobId, reference.id, FULL_REVIEW);
    expect((await approved.completion!).kind).toBe("FAILED");
    job = await h.service.getJob(h.jobId);
    const sceneId = job.scenes.find(scene => scene.attempts.at(-1)?.ugc)!.sceneId;
    const quote = await h.service.quoteFailedSceneRetry(h.jobId, sceneId);
    expect(quote.stage).toBe("ugc_video");
    videoOptions.fail = false;
    await (await h.service.retryFailedScene(h.jobId, sceneId, quote.token)).completion;

    job = await h.service.getJob(h.jobId);
    expect(job.scenes.find(scene => scene.sceneId === sceneId)!.attempts).toHaveLength(2);
    expect(videos.flatMap(provider => provider.calls)).toHaveLength(2);
    expect(h.calls.presenter()).toBe(0);
    expect((await h.service.listCostEntries()).filter(entry => entry.sceneId === sceneId && !entry.simulated)).toHaveLength(0);
  });
});
