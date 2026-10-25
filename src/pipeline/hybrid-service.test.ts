import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAppConfig } from "@/config/env";
import { MOCK_STAGE_MODES, type ExecutionStage, type StageModes } from "@/domain/execution";
import { withRealStageAuthorization, assertRealCallsEnabled } from "@/config/execution-policy";
import { createHybridPipelineService, hybridCapabilities } from "./hybrid-service";
import { MockCreativePlanner, buildMockDraft } from "@/ai/mock-planner";
import { LlmCreativePlanner } from "@/ai/llm-planner";
import { ScriptedLlm, response } from "@/test/fake-llm";
import { campaignRequest, product } from "@/test/fixtures";
import { randomId } from "@/lib/ids";
import { QUALITY_PRESETS } from "@/config/quality-presets";
import { fakeElevenLabs } from "@/test/elevenlabs-fake";
import { fakePresenter, wav } from "@/test/presenter-fake";
import { runwayFixture } from "@/test/runway-fake";
import { ElevenLabsAudioProvider } from "@/providers/audio/elevenlabs-audio-provider";
import { RunwayPresenterProvider } from "@/providers/presenter/runway-presenter-provider";
import { RunwayVideoProvider } from "@/providers/video/runway-video-provider";
import { MockPresenterProvider } from "@/providers/presenter/mock-presenter-provider";
import { MockAudioProvider } from "@/providers/audio/mock-audio-provider";
import { MockVideoProvider } from "@/providers/video/mock-video-provider";
import { ELEVENLABS_VOICES } from "@/config/voices";
import { VersionedMockRenderer } from "./offline-service";
import { FileCostLedger } from "@/storage/file-cost-ledger";
import { FilePipelineStore } from "@/storage/file-pipeline-store";
import type { PipelineDeps } from "./pipeline-service";
import { getCampaignView } from "@/application/campaign-actions";
import { LocalUploadStore } from "@/storage/upload-store";
import type { JobRun } from "./dispatch";

async function setup(modes: Partial<StageModes> = {}, avatar = true, options: { pending?: boolean; short?: boolean; timeout?: boolean; videoPending?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "hybrid-stage-"));
  const videoOptions = { pending: options.videoPending };
  const video = await runwayFixture(videoOptions);
  const config = loadAppConfig({ DATA_DIR: join(root,"data"), AUDIO_DIR: join(root,"audio"), VIDEOS_DIR: join(root,"videos"), RENDERS_DIR: join(root,"renders"), UPLOADS_DIR: join(video.root,"uploads") });
  const input = campaignRequest({ product: product({ images: [{ id: "img", uri: video.request.referenceImageUris[0]! }] }), stageModes: { ...MOCK_STAGE_MODES, ...modes }, scriptMode: "generate", presenterPresetId: avatar ? "influencer" : undefined });
  const llm = new ScriptedLlm([response(JSON.stringify(buildMockDraft({ product: input.product, creativeCount: 1, styles: input.styles, settings: QUALITY_PRESETS.economy }))) ]);
  const audio = fakeElevenLabs({ secondsPerChar: 0.045, timeout: options.timeout });
  const presenter = fakePresenter(options);
  const mockRenderer = new VersionedMockRenderer(); let realRenders = 0;
  const hybrid: NonNullable<PipelineDeps["hybrid"]> = {
    capabilities: Object.fromEntries(["planning", "narration", "scenes", "avatar", "render"].map(s => [s, { available: true, provider: "fake" }])) as NonNullable<PipelineDeps["hybrid"]>["capabilities"],
    planner: mode => mode === "real" ? new LlmCreativePlanner(llm, randomId, { maxValidationAttempts: 1 }) : new MockCreativePlanner(randomId),
    audio: (pricing, mode) => mode === "real" ? new ElevenLabsAudioProvider({ pricing, apiKey: "fake-secret", voices: ELEVENLABS_VOICES, timeoutMs: 5000, transport: audio.transport }) : new MockAudioProvider({ pricing }),
    video: (pricing, mode) => mode === "real" ? new RunwayVideoProvider({ pricing, apiKey: "fake-video", uploadsDir: config.uploadsDir, transport: video.transport }) : new MockVideoProvider({ pricing }),
    presenter: (pricing, mode) => mode === "real" ? new RunwayPresenterProvider({ pricing, apiKey: "fake-avatar", transport: presenter.transport }) : new MockPresenterProvider(pricing),
    renderer: mode => mode === "mock" ? mockRenderer : { id: "remotion", isMock: false, render: async manifest => { realRenders++; return { outputUri: `fake-render-v${realRenders}`, renderId: `v${realRenders}`, usage: { generations: 1 }, isMock: false, durationSeconds: manifest.duration, warnings: [] }; } },
  };
  const build = (overrides: Partial<PipelineDeps> = {}) => createHybridPipelineService(config, { hybrid, stageDelayMs: 0, presenterAudioSlicer: async (_path, window) => wav(window.endSeconds-window.startSeconds), pollOptions: { maxPolls: 2, intervalMs: 0, sleep: async () => {} }, ...overrides });
  const service = build(); const campaign = await service.planCampaign(input);
  const ledger = () => new FileCostLedger(config.dataDir).list({ campaignId: campaign.id });
  const execute = async (stage: ExecutionStage, target = service) => {
    const id = (await target.getCampaign(campaign.id)).jobIds[0]!;
    const q = await target.quoteStage(id, stage); expect(q.ready, q.blocked).toBe(true);
    return (await target.executeStage(id, stage, q.token)).completion;
  };
  return { root, config, service, campaign, input, llm, audio, presenter, video, videoOptions, build, ledger, execute, get realRenders() { return realRenders; } };
}

describe("execução híbrida por etapa — somente transportes falsos", () => {
  it("aprova uma vez e percorre automaticamente o job MOCK inteiro", async () => {
    const f = await setup();
    const jobId = f.campaign.jobIds[0]!;
    const quote = await f.service.quoteJob(jobId);
    expect(quote.ready).toBe(true);
    expect(quote.maximumAuthorizedBrl).toBe(0);
    const outcome = await (await f.service.authorizeAndRunJob(jobId, quote.token)).completion;
    expect(outcome.kind).toBe("COMPLETED");
    expect((await f.service.getJob(jobId)).jobAuthorization?.status).toBe("completed");
    expect(f.audio.calls).toHaveLength(0);
    expect(f.video.calls).toHaveLength(0);
    expect(f.presenter.posts).toBe(0);
  });

  it("executa providers falsos automaticamente sem ultrapassar o teto autorizado", async () => {
    const f = await setup({ narration: "real", scenes: "real", avatar: "real", render: "real" });
    const jobId = f.campaign.jobIds[0]!;
    const quote = await f.service.quoteJob(jobId);
    expect(quote.maximumAuthorizedBrl).toBeGreaterThan(0);
    const outcome = await (await f.service.authorizeAndRunJob(jobId, quote.token)).completion;
    expect(outcome.kind).toBe("COMPLETED");
    expect(f.audio.calls).toHaveLength(1);
    expect(f.presenter.posts).toBeGreaterThanOrEqual(1);
    expect(f.video.calls.some(call => call.url.endsWith("/image_to_video"))).toBe(true);
    expect(f.realRenders).toBe(1);
  });

  it("para na primeira falha sem retry pago automático", async () => {
    const f = await setup({ narration: "real" }, false, { timeout: true });
    const jobId = f.campaign.jobIds[0]!;
    const quote = await f.service.quoteJob(jobId);
    const outcome = await (await f.service.authorizeAndRunJob(jobId, quote.token)).completion;
    expect(outcome.kind).toBe("FAILED");
    expect(f.audio.calls).toHaveLength(1);
    expect(f.video.calls).toHaveLength(0);
    expect(f.presenter.posts).toBe(0);
  });

  it("edita o storyboard antes da geração e invalida a cotação anterior", async () => {
    const f = await setup({}, false);
    const jobId = f.campaign.jobIds[0]!;
    const before = await f.service.quoteJob(jobId);
    const campaign = await f.service.getCampaign(f.campaign.id);
    const scene = campaign.plan!.creatives[0]!.scenes[0]!;
    const updated = await f.service.updateStoryboardScene(jobId, {
      sceneId: scene.id,
      narration: "Uma fala revisada e natural.",
      visualDescription: "Produto inteiro sobre uma mesa clara.",
      visualSource: "product_image",
    });
    expect(updated.storyboardRevision).toBe(1);
    const after = await f.service.quoteJob(jobId);
    expect(after.token).not.toBe(before.token);
    expect((await f.service.getCampaign(f.campaign.id)).plan!.creatives[0]!.scenes[0]!.narration).toBe("Uma fala revisada e natural.");
  });

  it("percorre projeto → roteiro → narração → avatar → cena → render inteiramente MOCK pelos botões de etapa", async () => {
    const f = await setup();
    const id = f.campaign.jobIds[0]!;
    const stages = [["narration", "Gerar narração"], ["avatar", "Gerar avatar"], ["scenes", "Gerar cena de produto"], ["render", "Renderizar vídeo final"]] as const;
    for (const [stage, expectedAction] of stages) {
      const view = await getCampaignView({ service: f.service, uploads: new LocalUploadStore(f.config.uploadsDir), audioDir: f.config.audioDir, rendersDir: f.config.rendersDir }, f.campaign.id);
      expect(view.ok && view.value.creatives[0]!.nextAction?.label).toContain(expectedAction);
      for (let clicks = 0; clicks < 10; clicks++) {
        const quote = await f.service.quoteStage(id, stage);
        if (quote.done) break;
        expect(quote.mode).toBe("mock");
        expect(quote.estimatedBrl).toBe(0);
        expect(quote.ready, quote.blocked).toBe(true);
        await (await f.service.executeStage(id, stage, quote.token)).completion;
      }
      expect((await f.service.quoteStage(id, stage)).done).toBe(true);
    }
    expect((await f.service.getJob(id)).status).toBe("completed");
    expect((await f.ledger()).every(entry => entry.simulated)).toBe(true);
    expect(f.llm.requests).toHaveLength(0);
    expect(f.audio.calls).toHaveLength(0);
    expect(f.presenter.posts).toBe(0);
    expect(f.video.calls).toHaveLength(0);
  });

  it("percorre o protocolo completo da interface com transportes falsos e sem rede externa", async () => {
    const f = await setup({ planning: "real", narration: "real", scenes: "real", avatar: "real", render: "real" });
    const planning = await f.service.quotePlanning(f.campaign.id);
    expect(planning.preflight?.every(check => check.ok)).toBe(true);
    await (await f.service.executePlanning(f.campaign.id, planning.token)).completion;
    const jobId = (await f.service.getCampaign(f.campaign.id)).jobIds[0]!;

    const runUntilDone = async (stage: "narration" | "avatar" | "scenes" | "render") => {
      for (let clicks = 0; clicks < 10; clicks++) {
        const quote = await f.service.quoteStage(jobId, stage);
        if (quote.done) return;
        expect(quote.ready, quote.blocked).toBe(true);
        expect(quote.preflight?.filter(check => check.id !== "budget").every(check => check.ok), `${stage}: ${JSON.stringify(quote.preflight)}`).toBe(true);
        await (await f.service.executeStage(jobId, stage, quote.token)).completion;
      }
      throw new Error(`Etapa ${stage} não concluiu dentro do limite do teste`);
    };

    await runUntilDone("narration");
    await runUntilDone("avatar");
    await runUntilDone("scenes");
    await runUntilDone("render");

    const completed = await f.service.getJob(jobId);
    expect(completed.status).toBe("completed");
    expect(f.llm.requests).toHaveLength(1);
    expect(f.audio.calls).toHaveLength(1);
    expect(f.presenter.posts).toBeGreaterThanOrEqual(1);
    expect(f.video.calls.filter(call => call.url.endsWith("/image_to_video")).length).toBeGreaterThanOrEqual(1);
    expect(f.realRenders).toBe(1);
  });
  it("mantém o fluxo inteiro MOCK com aprovação, ledger e render versionado", async () => {
    const f = await setup(); const id = f.campaign.jobIds[0]!;
    const job = await f.service.getJob(id); await f.service.requestApproval(id); await f.service.approve(id, { estimateId: job.estimate!.id });
    expect(await f.service.generate(id)).toMatchObject({ kind: "COMPLETED" });
    expect((await f.ledger()).every(e => e.simulated)).toBe(true);
    expect(f.audio.calls).toHaveLength(0); expect(f.presenter.posts).toBe(0);
  });
  it("cria Claude REAL em draft, mostra pior caso e só executa com aprovação da cotação", async () => {
    const f = await setup({ planning: "real", narration: "real" });
    expect(f.campaign.status).toBe("draft"); expect(f.llm.requests).toHaveLength(0);
    const q = await f.service.quotePlanning(f.campaign.id); expect(q.estimatedBrl).toBeGreaterThan(0);
    await expect(f.service.executePlanning(f.campaign.id, "wrong")).rejects.toThrow();
    await (await f.service.executePlanning(f.campaign.id, q.token)).completion;
    expect(f.llm.requests).toHaveLength(1); expect(f.audio.calls).toHaveLength(0); expect(f.presenter.posts).toBe(0);
    expect((await f.ledger()).some(e => !e.simulated && e.category === "llm")).toBe(true);
  });
  it("permite ElevenLabs REAL + vídeo/avatar MOCK + render local REAL sem cascata paga", async () => {
    const f = await setup({ narration: "real", render: "real" });
    expect(await f.execute("narration")).toMatchObject({ kind: "WAITING_STAGE" });
    expect(f.audio.calls).toHaveLength(1); expect(f.presenter.posts).toBe(0); expect(f.realRenders).toBe(0);
    const id = f.campaign.jobIds[0]!; const audio = (await f.service.getJob(id)).audioAttempts[0]!;
    expect(audio.isMock).toBe(false); expect(audio.narration?.version).toBe("v1");
    await f.execute("scenes"); await f.execute("avatar");
    expect(f.realRenders).toBe(0);
    expect(await f.execute("render")).toMatchObject({ kind: "COMPLETED" }); expect(f.realRenders).toBe(1);
    expect(f.audio.calls).toHaveLength(1); expect(f.video.calls).toHaveLength(0);
    const view = await getCampaignView({ service: f.service, uploads: new LocalUploadStore(f.config.uploadsDir), audioDir: f.config.audioDir, rendersDir: f.config.rendersDir }, f.campaign.id);
    expect(view.ok && view.value.creatives[0]!.stageQuotes?.find(q => q.stage === "narration")?.actualBrl).toBeGreaterThan(0);
  });
  it("gera UMA cena REAL por clique, mantém as três durações e rejeita cotação antiga", async () => {
    const f = await setup({ scenes: "real" }, false); const id = f.campaign.jobIds[0]!;
    const first = await f.service.quoteStage(id, "scenes"); expect(first.estimatedBrl).toBeGreaterThan(0);
    await (await f.service.executeStage(id, "scenes", first.token)).completion;
    expect(f.video.calls.filter(c => c.url.endsWith("/image_to_video"))).toHaveLength(1);
    const job = await f.service.getJob(id); const real = job.scenes.flatMap(s => s.attempts).filter(a => !a.isMock);
    expect(real).toHaveLength(1); expect(real[0]!.media).toMatchObject({ requestedDurationSeconds: 5, actualMediaDurationSeconds: 5, status: "valid" });
    await expect(f.service.executeStage(id, "scenes", first.token)).rejects.toThrow();
    const next = await f.service.quoteStage(id, "scenes"); expect(next.unit).not.toBe(first.unit);
    expect(f.video.calls.filter(c => c.url.endsWith("/image_to_video"))).toHaveLength(1);
  });
  it("troca MOCK para REAL preservando tentativas, custo e render anteriores até o sucesso", async () => {
    const f = await setup({}, false); const id = f.campaign.jobIds[0]!;
    await f.execute("narration"); await f.execute("scenes"); await f.execute("render");
    const before = await f.service.getJob(id); const spent = await f.ledger();
    await f.service.configureStage(id, "narration", "real");
    const selected = await f.service.getJob(id); expect(selected.audioAttempts).toEqual(before.audioAttempts); expect(selected.renders).toEqual(before.renders);
    await f.execute("narration");
    const after = await f.service.getJob(id); expect(after.audioAttempts).toHaveLength(2); expect(after.audioAttempts[0]?.active).toBe(false); expect(after.renders).toEqual(before.renders);
    expect((await f.ledger()).length).toBeGreaterThan(spent.length);
  });
  it("avatar REAL bloqueia áudio mock e não gera uma voz por conta própria", async () => {
    const f = await setup({ avatar: "real" }); const id = f.campaign.jobIds[0]!;
    await f.execute("narration"); const q = await f.service.quoteStage(id, "avatar");
    expect(q.ready).toBe(false); expect(q.blocked).toMatch(/narração real/); expect(f.audio.calls).toHaveLength(0); expect(f.presenter.posts).toBe(0);
  });
  it("restart após timeout de TTS bloqueia reenvio incerto e não reutiliza a aprovação", async () => {
    const f = await setup({ narration: "real" }, false, { timeout: true }); const id = f.campaign.jobIds[0]!;
    await f.execute("narration"); expect(f.audio.calls).toHaveLength(1);
    const reopened = f.build(); const q = await reopened.quoteStage(id, "narration");
    // Uma falha conhecida exige novo clique; nunca é repetida pela retomada ou render.
    if (q.ready) { expect((await reopened.getJob(id)).audioAttempts).toHaveLength(1); }
    else expect(q.blocked).toBeTruthy();
    expect(f.audio.calls).toHaveLength(1);
  });
  it("retoma presenter pendente pelo ID após restart sem repetir POST", async () => {
    const f = await setup({ narration: "real", avatar: "real" }, true, { pending: true }); const id = f.campaign.jobIds[0]!;
    await f.execute("narration"); await f.execute("avatar"); expect(f.presenter.posts).toBe(1);
    f.presenter.options.pending = false;
    const reopened = f.build(); expect(await f.execute("avatar", reopened)).toMatchObject({ kind: "WAITING_STAGE" });
    expect(f.presenter.posts).toBe(1); expect(f.audio.calls).toHaveLength(1);
    expect((await reopened.getJob(id)).scenes.flatMap(s => s.attempts).some(a => a.presenter && a.media?.status === "valid")).toBe(true);
  });
  it("bloqueia orçamento e limite de tentativas antes de qualquer chamada", async () => {
    const f = await setup({ narration: "real" }, false); const id = f.campaign.jobIds[0]!;
    const store = new FilePipelineStore(f.config.dataDir); const campaign = await store.getCampaign(f.campaign.id);
    await store.saveCampaign({ ...campaign, request: { ...campaign.request, budget: { maxCostPerCreativeBrl: 0.001, maxCostPerCampaignBrl: 0.001, allowOverBudget: false } } });
    const q = await f.service.quoteStage(id, "narration"); expect(q.blocked).toMatch(/Orçamento/); await expect(f.service.executeStage(id,"narration",q.token)).rejects.toThrow(); expect(f.audio.calls).toHaveLength(0);
  });
  it("capabilities não expõem segredos e REAL indisponível não pode ser forjado", async () => {
    const config = loadAppConfig({}); const caps = hybridCapabilities(config, { ANTHROPIC_API_KEY: "secret" });
    expect(caps.planning.available).toBe(false); expect(caps.avatar.available).toBe(false); expect(JSON.stringify(caps)).not.toContain('"secret"');
    const root = await mkdtemp(join(tmpdir(),"hybrid-denied-")); const service = createHybridPipelineService({ ...config, dataDir: root }, {}, {});
    await expect(service.planCampaign(campaignRequest({ stageModes: { ...MOCK_STAGE_MODES, narration: "real" } }))).rejects.toThrow(/Configure/);
  });
  it("retoma vídeo REAL pelo mesmo ID após restart, sem POST e sem custo duplicado", async () => {
    const f = await setup({ scenes: "real" }, false, { videoPending: true }); const id = f.campaign.jobIds[0]!;
    await f.execute("scenes");
    expect(f.video.calls.filter(c => c.url.endsWith("/image_to_video"))).toHaveLength(1);
    const before = await f.service.getJob(id); expect(before.videoTasks?.[0]?.state).toBe("pending");
    f.videoOptions.pending = false;
    const restarted = f.build(); await f.execute("scenes", restarted);
    expect(f.video.calls.filter(c => c.url.endsWith("/image_to_video"))).toHaveLength(1);
    const job = await restarted.getJob(id); expect(job.videoTasks?.[0]?.state).toBe("settled");
    expect(job.scenes.flatMap(s => s.attempts).filter(a => a.active && !a.isMock)).toHaveLength(1);
    expect((await f.ledger()).filter(e => e.category === "video" && !e.simulated)).toHaveLength(1);
  });
  it("nova versão exige outra cotação, mantém o histórico e respeita o limite", async () => {
    const f = await setup({ narration: "real" }, false); const id = f.campaign.jobIds[0]!;
    await f.execute("narration");
    for (let i = 0; i < 2; i++) {
      const quote = await f.service.quoteStage(id, "narration", false, true); expect(quote.ready, quote.blocked).toBe(true);
      await (await f.service.executeStage(id, "narration", quote.token, { regenerate: true })).completion;
    }
    const attempts = (await f.service.getJob(id)).audioAttempts;
    expect(attempts).toHaveLength(3); expect(attempts.filter(a => a.active)).toHaveLength(1);
    expect(new Set(attempts.map(a => a.narration?.version)).size).toBe(3);
    const blocked = await f.service.quoteStage(id, "narration", false, true); expect(blocked.blocked).toMatch(/Limite de tentativas/);
    expect(f.audio.calls).toHaveLength(3);
  });
  it("refaz a cena escolhida, mostra cotação própria e preserva a versão anterior", async () => {
    const f = await setup();
    const id = f.campaign.jobIds[0]!;
    const jobQuote = await f.service.quoteJob(id);
    expect((await (await f.service.authorizeAndRunJob(id, jobQuote.token)).completion).kind).toBe("COMPLETED");
    const campaign = await f.service.getCampaign(f.campaign.id);
    const generated = campaign.plan!.creatives[0]!.scenes.filter(scene => scene.requiresGeneratedVideo);
    const target = generated.at(-1)!;
    const before = await f.service.getJob(id);
    const untouched = generated[0]!;
    const stage = target.visualSource === "presenter" ? "avatar" : "scenes";
    const quote = await f.service.quoteStage(id, stage, false, true, target.id);
    expect(quote.ready, quote.blocked).toBe(true);
    expect(quote.unit).toBe(target.id);
    await (await f.service.executeStage(id, stage, quote.token, { regenerate: true, sceneId: target.id })).completion;
    const after = await f.service.getJob(id);
    expect(after.scenes.find(scene => scene.sceneId === target.id)!.attempts).toHaveLength(2);
    expect(after.scenes.find(scene => scene.sceneId === untouched.id)!.attempts).toHaveLength(before.scenes.find(scene => scene.sceneId === untouched.id)!.attempts.length);
    expect(after.scenes.find(scene => scene.sceneId === target.id)!.attempts.filter(attempt => attempt.active)).toHaveLength(1);
  });
  it("cotação de retry da cena falha existe só para a tentativa terminal correta", async () => {
    const f = await setup();
    const id = f.campaign.jobIds[0]!;
    const jobQuote = await f.service.quoteJob(id);
    expect((await (await f.service.authorizeAndRunJob(id, jobQuote.token)).completion).kind).toBe("COMPLETED");
    const campaign = await f.service.getCampaign(f.campaign.id);
    const target = campaign.plan!.creatives[0]!.scenes.find(scene => scene.requiresGeneratedVideo)!;
    const store = new FilePipelineStore(f.config.dataDir);
    const completed = await store.getJob(id);
    const failedAttemptId = completed.scenes.find(scene => scene.sceneId === target.id)!.attempts.at(-1)!.id;
    await store.saveJob({
      ...completed,
      status: "failed",
      error: "Falha terminal controlada",
      scenes: completed.scenes.map(scene => scene.sceneId === target.id
        ? { ...scene, attempts: scene.attempts.map(attempt => attempt.id === failedAttemptId ? { ...attempt, status: "failed" as const, active: false, error: "Falha terminal controlada" } : attempt) }
        : scene),
    });

    const quote = await f.service.quoteFailedSceneRetry(id, target.id);
    expect(quote).toMatchObject({ ready: true, unit: target.id, regenerate: true });

    const readyScene = campaign.plan!.creatives[0]!.scenes.find(scene => scene.requiresGeneratedVideo && scene.id !== target.id)!;
    const readyQuote = await f.service.quoteFailedSceneRetry(id, readyScene.id);
    expect(readyQuote.ready).toBe(false);
    expect(readyQuote.blocked).toMatch(/não está com falha terminal/i);

    await expect(f.service.quoteFailedSceneRetry(id, "scene_from_other_campaign")).rejects.toThrow(/não pertence/i);
  });
  it("retry seguro de cena falha consome uma aprovação uma vez e preserva tentativas e ledger", async () => {
    const f = await setup({ scenes: "real" }, false);
    const id = f.campaign.jobIds[0]!;
    (f.videoOptions as { failure?: boolean }).failure = true;
    const first = await f.service.quoteStage(id, "scenes");
    expect((await (await f.service.executeStage(id, "scenes", first.token)).completion).kind).toBe("FAILED");
    const failedJob = await f.service.getJob(id);
    const failedScene = failedJob.scenes.find(scene => scene.attempts.at(-1)?.status === "failed")!;
    const callsAfterFailure = f.video.calls.filter(call => call.url.endsWith("/image_to_video")).length;
    const ledgerAfterFailure = (await f.ledger()).filter(entry => !entry.simulated).length;
    const quote = await f.service.quoteFailedSceneRetry(id, failedScene.sceneId);

    await expect(f.service.retryFailedScene(id, failedScene.sceneId, "0".repeat(64))).rejects.toThrow();
    expect(f.video.calls.filter(call => call.url.endsWith("/image_to_video"))).toHaveLength(callsAfterFailure);

    (f.videoOptions as { failure?: boolean }).failure = false;
    const approved = await f.service.retryFailedScene(id, failedScene.sceneId, quote.token);
    expect((await approved.completion).kind).toBe("WAITING_STAGE");
    expect(f.video.calls.filter(call => call.url.endsWith("/image_to_video"))).toHaveLength(callsAfterFailure + 1);

    const after = await f.service.getJob(id);
    expect(after.scenes.find(scene => scene.sceneId === failedScene.sceneId)!.attempts).toHaveLength(2);
    expect((await f.ledger()).filter(entry => !entry.simulated)).toHaveLength(ledgerAfterFailure + 1);

    const replay = await f.service.retryFailedScene(id, failedScene.sceneId, quote.token);
    await replay.completion;
    expect(f.video.calls.filter(call => call.url.endsWith("/image_to_video"))).toHaveLength(callsAfterFailure + 1);
  });
  it("retoma intent autorizada após queda antes do enqueue e submete exatamente uma vez", async () => {
    const f = await setup({ scenes: "real" }, false);
    const id = f.campaign.jobIds[0]!;
    (f.videoOptions as { failure?: boolean }).failure = true;
    const first = await f.service.quoteStage(id, "scenes");
    await (await f.service.executeStage(id, "scenes", first.token)).completion;
    const failed = await f.service.getJob(id);
    const sceneId = failed.scenes.find(scene => scene.attempts.at(-1)?.status === "failed")!.sceneId;
    const quote = await f.service.quoteFailedSceneRetry(id, sceneId);
    const persistedRuns: JobRun[] = [];
    let crashBeforeEnqueue = true;
    const dispatcher: NonNullable<PipelineDeps["dispatcher"]> = {
      enqueuePlanning: async () => {},
      enqueueJob: async (_job, run) => {
        if (crashBeforeEnqueue) throw new Error("queda simulada antes do enqueue");
        persistedRuns.push(run);
      },
    };
    const api = f.build({ dispatcher });
    await expect(api.retryFailedScene(id, sceneId, quote.token)).rejects.toThrow(/queda simulada/);
    expect((await api.getJob(id)).sceneRetryIntents).toMatchObject([{ sceneId, quoteToken: quote.token, state: "authorized" }]);
    expect(persistedRuns).toHaveLength(0);

    crashBeforeEnqueue = false;
    const resumed = await api.retryFailedScene(id, sceneId, quote.token);
    expect((await resumed.completion).kind).toBe("QUEUED");
    expect(persistedRuns).toHaveLength(1);
    (f.videoOptions as { failure?: boolean }).failure = false;
    await f.build().runJobTask(id, persistedRuns[0]!);
    expect(f.video.calls.filter(call => call.url.endsWith("/image_to_video"))).toHaveLength(2);

    await api.retryFailedScene(id, sceneId, quote.token);
    expect(persistedRuns).toHaveLength(1);
    expect(f.video.calls.filter(call => call.url.endsWith("/image_to_video"))).toHaveLength(2);
  });
  it("cotação stale é bloqueada antes do provider e libera uma nova decisão", async () => {
    const f = await setup({ scenes: "real" }, false);
    const id = f.campaign.jobIds[0]!;
    (f.videoOptions as { failure?: boolean }).failure = true;
    const first = await f.service.quoteStage(id, "scenes");
    await (await f.service.executeStage(id, "scenes", first.token)).completion;
    const failed = await f.service.getJob(id);
    const sceneId = failed.scenes.find(scene => scene.attempts.at(-1)?.status === "failed")!.sceneId;
    const quote = await f.service.quoteFailedSceneRetry(id, sceneId);
    const runs: JobRun[] = [];
    const api = f.build({ dispatcher: { enqueuePlanning: async () => {}, enqueueJob: async (_job, run) => { runs.push(run); } } });
    await api.retryFailedScene(id, sceneId, quote.token);
    const store = new FilePipelineStore(f.config.dataDir);
    const authorized = await store.getJob(id);
    await store.saveJob({ ...authorized, stageRevision: (authorized.stageRevision ?? 0) + 1 });
    const calls = f.video.calls.filter(call => call.url.endsWith("/image_to_video")).length;

    const stale = await f.build().runJobTask(id, runs[0]!);
    expect(stale.kind).toBe("FAILED");
    expect(f.video.calls.filter(call => call.url.endsWith("/image_to_video"))).toHaveLength(calls);
    expect((await f.service.getJob(id))).toMatchObject({ status: "failed", sceneRetryIntents: [{ state: "settled", outcome: "blocked" }] });

    const fresh = await api.quoteFailedSceneRetry(id, sceneId);
    expect(fresh.token).not.toBe(quote.token);
    (f.videoOptions as { failure?: boolean }).failure = false;
    await api.retryFailedScene(id, sceneId, fresh.token);
    await f.build().runJobTask(id, runs[1]!);
    expect(f.video.calls.filter(call => call.url.endsWith("/image_to_video"))).toHaveLength(calls + 1);
  });
  it("operação paga incerta bloqueia retry de cena em todos os recipes duráveis", async () => {
    const f = await setup({ scenes: "real" }, false);
    const id = f.campaign.jobIds[0]!;
    (f.videoOptions as { failure?: boolean }).failure = true;
    const first = await f.service.quoteStage(id, "scenes");
    await (await f.service.executeStage(id, "scenes", first.token)).completion;
    const store = new FilePipelineStore(f.config.dataDir);
    const failed = await store.getJob(id);
    const sceneId = failed.scenes.find(scene => scene.attempts.at(-1)?.status === "failed")!.sceneId;
    const latest = failed.scenes.find(scene => scene.sceneId === sceneId)!.attempts.at(-1)!;
    const now = failed.updatedAt;
    const markers = [
      { stageIntents: [{ stage: "scenes" as const, unit: sceneId, state: "running" as const, createdAt: now }] },
      { presenterTasks: [{ attemptId: "presenter_uncertain", sceneId, avatarPresetId: "influencer" as const, state: "submitting" as const, requestedDurationSeconds: 4, audio: { narrationAttemptId: "audio_1", narrationVersion: "v1", startSeconds: 0, endSeconds: 4 }, estimatedCostUsd: 0.1, createdAt: now }] },
      { videoTasks: [{ attemptId: latest.id, sceneId, state: "pending" as const, providerJobId: "video_op_1", provider: "runway", model: "gen4_turbo", createdAt: now }] },
      { ugcVideoOperations: [{ attemptId: latest.id, sceneId, state: "uncertain" as const, provider: "veo", model: "veo-3.1-fast-generate-preview", referenceId: "ref_1", referenceVersion: "v1", requestedDurationSeconds: 8, estimatedCostUsd: 0.8, createdAt: now }] },
    ];
    const calls = f.video.calls.length;
    for (const marker of markers) {
      await store.saveJob({ ...failed, stageIntents: undefined, presenterTasks: undefined, videoTasks: undefined, ugcVideoOperations: undefined, ...marker });
      const quote = await f.service.quoteFailedSceneRetry(id, sceneId);
      expect(quote.ready).toBe(false);
      expect(quote.blocked).toMatch(/segurança|sem confirmação/i);
      await expect(f.service.retryFailedScene(id, sceneId, quote.token)).rejects.toThrow(/segurança|sem confirmação/i);
      expect(f.video.calls).toHaveLength(calls);
    }
  });
  it("duas aprovações concorrentes usam uma intent e uma nova falha exige outra quote", async () => {
    const f = await setup({ scenes: "real" }, false);
    const id = f.campaign.jobIds[0]!;
    (f.videoOptions as { failure?: boolean }).failure = true;
    const first = await f.service.quoteStage(id, "scenes");
    await (await f.service.executeStage(id, "scenes", first.token)).completion;
    let job = await f.service.getJob(id);
    const sceneId = job.scenes.find(scene => scene.attempts.at(-1)?.status === "failed")!.sceneId;
    const quoteA = await f.service.quoteFailedSceneRetry(id, sceneId);
    const [a, b] = await Promise.all([
      f.service.retryFailedScene(id, sceneId, quoteA.token),
      f.service.retryFailedScene(id, sceneId, quoteA.token),
    ]);
    await Promise.all([a.completion, b.completion]);
    expect(f.video.calls.filter(call => call.url.endsWith("/image_to_video"))).toHaveLength(2);
    job = await f.service.getJob(id);
    expect(job.sceneRetryIntents).toHaveLength(1);
    expect(job.scenes.find(scene => scene.sceneId === sceneId)!.attempts).toHaveLength(2);

    await f.service.retryFailedScene(id, sceneId, quoteA.token);
    expect(f.video.calls.filter(call => call.url.endsWith("/image_to_video"))).toHaveLength(2);
    const quoteB = await f.service.quoteFailedSceneRetry(id, sceneId);
    expect(quoteB.token).not.toBe(quoteA.token);
    (f.videoOptions as { failure?: boolean }).failure = false;
    await (await f.service.retryFailedScene(id, sceneId, quoteB.token)).completion;
    expect(f.video.calls.filter(call => call.url.endsWith("/image_to_video"))).toHaveLength(3);
  });
  it("retry de Presenter deriva avatar no servidor, preserva áudio e lança só o novo custo", async () => {
    const f = await setup({ narration: "real", avatar: "real" }, true, { short: true });
    const id = f.campaign.jobIds[0]!;
    await f.execute("narration");
    const avatar = await f.service.quoteStage(id, "avatar");
    expect((await (await f.service.executeStage(id, "avatar", avatar.token)).completion).kind).toBe("FAILED");
    const failed = await f.service.getJob(id);
    const sceneId = failed.scenes.find(scene => scene.attempts.at(-1)?.presenter)?.sceneId!;
    const before = (await f.ledger()).filter(entry => entry.sceneId === sceneId && !entry.simulated);
    const quote = await f.service.quoteFailedSceneRetry(id, sceneId);
    expect(quote.stage).toBe("avatar");
    f.presenter.options.short = false;
    await (await f.service.retryFailedScene(id, sceneId, quote.token)).completion;

    const after = await f.service.getJob(id);
    expect(after.scenes.find(scene => scene.sceneId === sceneId)!.attempts).toHaveLength(2);
    expect(f.presenter.posts).toBe(2);
    expect(f.audio.calls).toHaveLength(1);
    expect((await f.ledger()).filter(entry => entry.sceneId === sceneId && !entry.simulated)).toHaveLength(before.length + 1);
  });
  it("autoriza exceder só até o valor mostrado e somente com permissão da política", async () => {
    const f = await setup({ narration: "real" }, false); const id = f.campaign.jobIds[0]!;
    const store = new FilePipelineStore(f.config.dataDir); const campaign = await store.getCampaign(f.campaign.id);
    await store.saveCampaign({ ...campaign, request: { ...campaign.request, budget: { maxCostPerCreativeBrl: 0.001, maxCostPerCampaignBrl: 0.001, allowOverBudget: true } } });
    const quote = await f.service.quoteStage(id,"narration"); expect(quote.budgetDecision?.canAuthorizeOverBudget).toBe(true);
    await expect(f.service.executeStage(id,"narration",quote.token)).rejects.toThrow();
    const authorized = await (await f.service.executeStage(id,"narration",quote.token,{authorizeOverBudget:true})).completion; expect(authorized.kind, JSON.stringify(authorized)).toBe("WAITING_STAGE");
    expect(f.audio.calls).toHaveLength(0);
    const campaignQuote = await f.service.quoteStage(id,"narration"); expect(campaignQuote.budgetDecision?.scope).toBe("campaign");
    await (await f.service.executeStage(id,"narration",campaignQuote.token,{authorizeOverBudget:true})).completion;
    expect(f.audio.calls).toHaveLength(1); expect((await f.service.getJob(id)).overBudgetAuthorization).toBeDefined();
  });
  it("intenção sem ID após queda bloqueia reenvio e troca de modo", async () => {
    const f = await setup({ scenes: "real" }, false); const id = f.campaign.jobIds[0]!;
    const store = new FilePipelineStore(f.config.dataDir); const job = await store.getJob(id);
    await store.saveJob({ ...job, stageIntents: [{ stage: "scenes", unit: "scene", state: "running", createdAt: job.createdAt }] });
    const restarted = f.build(); const quote = await restarted.quoteStage(id,"scenes"); expect(quote.blocked).toMatch(/interrompida/);
    await expect(restarted.configureStage(id,"scenes","mock")).rejects.toThrow(/pendente/);
    expect(f.video.calls).toHaveLength(0);
  });
  it("render bloqueia dependências ausentes sem criar versão ou iniciar outro provider", async () => {
    const f = await setup({ render: "real" }); const id = f.campaign.jobIds[0]!;
    const quote = await f.service.quoteStage(id,"render"); expect(quote.ready).toBe(false); expect(quote.blocked).toMatch(/Conclua/); expect(quote.model).toBe("remotion");
    await expect(f.service.executeStage(id,"render",quote.token)).rejects.toThrow(); expect(f.realRenders).toBe(0); expect(f.audio.calls).toHaveLength(0);
  });
  it("adota job offline de ff176bb preservando plano, mídia, render e custos", async () => {
    const f = await setup({}, false); const id = f.campaign.jobIds[0]!;
    await f.execute("narration"); await f.execute("scenes"); await f.execute("render");
    const store = new FilePipelineStore(f.config.dataDir);
    const campaign = await store.getCampaign(f.campaign.id); const job = await store.getJob(id); const ledger = await f.ledger();
    await store.saveCampaign({ ...campaign, executionMode: "offline" }); await store.saveJob({ ...job, stageModes: undefined });
    await f.service.configureStage(id,"narration","real");
    const adopted = await f.service.getJob(id); expect(adopted.scenes).toEqual(job.scenes); expect(adopted.audioAttempts).toEqual(job.audioAttempts); expect(adopted.renders).toEqual(job.renders); expect(adopted.approval).toEqual(job.approval);
    expect((await store.getCampaign(campaign.id)).plan).toEqual(campaign.plan); expect(await f.ledger()).toEqual(ledger);
    expect(f.audio.calls).toHaveLength(0);
  });
  it("transporte real exige escopo isolado e no máximo uma criação, mas permite polling", async () => {
    expect(assertRealCallsEnabled).toThrow(/bloqueadas/);
    await withRealStageAuthorization("narration", async () => { assertRealCallsEnabled(); assertRealCallsEnabled(false); assertRealCallsEnabled(false); expect(assertRealCallsEnabled).toThrow(/bloqueadas/); });
    expect(assertRealCallsEnabled).toThrow(/bloqueadas/);
  });
});
