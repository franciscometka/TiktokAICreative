import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadAppConfig } from "@/config/env";
import { assertRealCallsEnabled, offlineConfig } from "@/config/execution-policy";
import { createOfflinePipelineService } from "./offline-service";
import { startCampaignPlanning, getCampaignView, type AppDeps } from "@/application/campaign-actions";
import { parseCampaignForm } from "@/application/campaign-form";
import { formInput, PNG_BYTES, until } from "@/test/app-fixtures";
import { LocalUploadStore } from "@/storage/upload-store";
import { FilePipelineStore } from "@/storage/file-pipeline-store";
import { FileCostLedger } from "@/storage/file-cost-ledger";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "offline-workflow-"));
  const config = loadAppConfig({ DATA_DIR: join(root,"data"), UPLOADS_DIR: join(root,"uploads"), AUDIO_DIR: join(root,"audio"), VIDEOS_DIR: join(root,"videos"), RENDERS_DIR: join(root,"renders"), MOCK_PLANNER_DELAY_MS: "1", LLM_PROVIDER: "anthropic", AUDIO_PROVIDER: "elevenlabs", VIDEO_PROVIDER: "runway", RENDERER: "remotion" });
  const build = () => createOfflinePipelineService(config, { stageDelayMs: 0 });
  const service = build();
  const deps: AppDeps = { service, uploads: new LocalUploadStore(config.uploadsDir), rendersDir: config.rendersDir, audioDir: config.audioDir, offlineOnly: true, audioProvider: "mock" };
  return { config, deps, build, service };
}

describe("fluxo utilizável inteiramente offline", () => {
  it("cria com imagens/conceito/roteiro/avatar, exige aprovação, conclui, reabre e versiona sem chamadas", async () => {
    const f = await setup();
    const network = vi.spyOn(globalThis, "fetch");
    try {
      const image = await f.deps.uploads.save("prod_test", { bytes: PNG_BYTES, size: PNG_BYTES.length, declaredType: "image/png" });
      const script = "Conheça a garrafa de aço. Veja a tampa e os detalhes do produto. Confira as informações antes de escolher.";
      const result = await startCampaignPlanning(f.deps, formInput({ projectName: "Projeto offline", videoConcept: "Avatar apresenta a garrafa", scriptMode: "manual", script, presenterPresetId: "influencer", imageIds: [image.id] }));
      if (!result.ok) throw new Error(JSON.stringify(result));
      const id = result.value.campaignId;
      await until(async () => !f.service.isPlanningActive(id));
      const campaign = await f.service.getCampaign(id);
      expect(campaign.executionMode).toBe("offline");
      expect(campaign.request.product.images[0]?.id).toBe(image.id);
      expect(campaign.plan!.creatives[0]!.script).toBe(script);
      expect(campaign.plan!.creatives[0]!.concept.description).toBe("Avatar apresenta a garrafa");
      const jobId = campaign.jobIds[0]!;
      await expect(f.service.generate(jobId)).rejects.toThrow();
      const job = await f.service.estimateCost(jobId);
      expect(job.estimate!.estimatedAdditionalBrl).toBeGreaterThan(0);
      expect(job.audioAttempts).toHaveLength(0);
      await f.service.requestApproval(jobId);
      expect((await f.service.approve(jobId, { estimateId: job.estimate!.id })).kind).toBe("APPROVED");
      expect((await f.service.generate(jobId)).kind).toBe("COMPLETED");
      const complete = await f.service.getJob(jobId);
      expect(complete.audioAttempts[0]).toMatchObject({ isMock: true, narration: { version: "mock-v1" } });
      expect(complete.presenterTasks![0]).toMatchObject({ isMock: true, avatarPresetId: "influencer" });
      expect(complete.presenterTasks![0]!.audio.narrationAttemptId).toBe(complete.audioAttempts[0]!.id);
      expect(complete.scenes.flatMap(s => s.attempts).every(a => !a.media)).toBe(true);
      const ledger = await new FileCostLedger(f.config.dataDir).list({ campaignId: id });
      expect(ledger.length).toBeGreaterThan(2);
      expect(ledger.every(e => e.simulated)).toBe(true);
      const reopened = f.build();
      const view = await getCampaignView({ ...f.deps, service: reopened }, id);
      if (!view.ok) throw new Error(JSON.stringify(view));
      expect(view.value.creatives[0]!.workflow!.every(s => s.state === "ready")).toBe(true);
      expect((await (await reopened.startRerender(jobId)).completion).kind).toBe("COMPLETED");
      const rerendered = await reopened.getJob(jobId);
      expect(rerendered.renders).toHaveLength(2);
      expect(new Set(rerendered.renders.map(r => r.outputUri)).size).toBe(2);
      expect(rerendered.audioAttempts).toHaveLength(1);
      expect((await new FileCostLedger(f.config.dataDir).list({ campaignId: id })).filter(e => e.category !== "rendering")).toEqual(ledger.filter(e => e.category !== "rendering"));
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });
  it("retoma um job interrompido com mídia salva sem duplicar narração, avatar ou ledger", async () => {
    const f = await setup();
    const result = await startCampaignPlanning(f.deps, formInput({ presenterPresetId: "influencer", scriptMode: "generate" }));
    if (!result.ok) throw new Error(JSON.stringify(result));
    await until(async () => !f.service.isPlanningActive(result.value.campaignId));
    const campaign = await f.service.getCampaign(result.value.campaignId);
    const job = await f.service.estimateCost(campaign.jobIds[0]!);
    await f.service.requestApproval(job.id);
    await f.service.approve(job.id, { estimateId: job.estimate!.id });
    await f.service.generate(job.id);
    const saved = await f.service.getJob(job.id);
    const ledger = await new FileCostLedger(f.config.dataDir).list({ jobId: job.id });
    await new FilePipelineStore(f.config.dataDir).saveJob({ ...saved, status: "generating", currentStage: "avatar" });
    const reopened = f.build();
    const view = await getCampaignView({ ...f.deps, service: reopened }, campaign.id);
    expect(view.ok && view.value.creatives[0]!.interrupted).toBe(true);
    expect((await (await reopened.startRerender(job.id)).completion).kind).toBe("COMPLETED");
    const resumed = await reopened.getJob(job.id);
    expect(resumed.audioAttempts).toEqual(saved.audioAttempts);
    expect(resumed.presenterTasks).toEqual(saved.presenterTasks);
    expect((await new FileCostLedger(f.config.dataDir).list({ jobId: job.id })).filter(e => e.category !== "rendering")).toEqual(ledger.filter(e => e.category !== "rendering"));
  });
  it("mantém campanhas anteriores consultáveis e bloqueia execução sem convertê-las", async () => {
    const f = await setup();
    const { campaignRequest } = await import("@/test/fixtures");
    const campaign = await f.service.planCampaign(campaignRequest());
    const store = new FilePipelineStore(f.config.dataDir);
    await store.saveCampaign({ ...campaign, executionMode: undefined });
    const view = await getCampaignView(f.deps, campaign.id);
    expect(view.ok && view.value.offlineReadOnly).toBe(true);
    await expect(f.service.estimateCost(campaign.jobIds[0]!)).rejects.toThrow(/offline/);
    expect((await store.getCampaign(campaign.id)).executionMode).toBeUndefined();
  });
  it("ignora providers reais no ambiente e não permite desbloqueio por confirmação", () => {
    expect(offlineConfig(loadAppConfig({ LLM_PROVIDER: "anthropic", VIDEO_PROVIDER: "runway", AUDIO_PROVIDER: "elevenlabs", RENDERER: "remotion" }))).toMatchObject({ llmProvider: "mock", videoProvider: "mock", audioProvider: "mock", renderer: { id: "mock" } });
    expect(assertRealCallsEnabled).toThrow(/bloqueadas/);
  });
  it("rejeita roteiro manual vazio e roteiro acima do limite antes de criar job", () => {
    expect(parseCampaignForm(formInput({ scriptMode: "manual", script: " " })).ok).toBe(false);
    expect(parseCampaignForm(formInput({ scriptMode: "manual", script: "palavra ".repeat(401) })).ok).toBe(false);
  });
});
