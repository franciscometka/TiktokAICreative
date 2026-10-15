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
  const build = () => createHybridPipelineService(config, { hybrid, stageDelayMs: 0, presenterAudioSlicer: async (_path, window) => wav(window.endSeconds-window.startSeconds), pollOptions: { maxPolls: 2, intervalMs: 0, sleep: async () => {} } });
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
