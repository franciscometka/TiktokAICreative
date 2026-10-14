import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ELEVENLABS_VOICES } from "@/config/voices";
import type { CostBudget } from "@/domain/cost";
import { createAudioProviderFactory } from "@/providers/audio";
import { ElevenLabsAudioProvider } from "@/providers/audio/elevenlabs-audio-provider";
import type { MockRenderer } from "@/render/renderer";
import { spokenNarrationCharacters } from "@/speech/narration-script";
import { InvalidRenderPathError } from "@/render/output-paths";
import { LocalAudioAssetStore, type AudioAssetStore } from "@/storage/audio-asset-store";
import { fakeElevenLabs, type FakeElevenLabsOptions } from "@/test/elevenlabs-fake";
import { BUDGET, campaignRequest, createHarness } from "@/test/fixtures";
import { discardedAttemptIds, UnexpectedStatusError } from "./guards";

const KEY = "sk_test_narration_0000";

function setup(fake: FakeElevenLabsOptions = {}, extra: { audioAssets?: AudioAssetStore; maxAttemptsPerScene?: number } = {}) {
  const http = fakeElevenLabs(fake);
  const h = createHarness({
    audioProvider: (pricing) =>
      new ElevenLabsAudioProvider({ pricing, apiKey: KEY, voices: ELEVENLABS_VOICES, timeoutMs: 5_000, transport: http.transport }),
    audioAssets: extra.audioAssets,
    maxAttemptsPerScene: extra.maxAttemptsPerScene,
  });
  return { h, http };
}

async function approved(h: ReturnType<typeof createHarness>, budget: CostBudget = BUDGET, speakerProfileId = "rafael") {
  const campaign = await h.service.planCampaign(campaignRequest({ budget, speakerProfileId }));
  const jobId = campaign.jobIds[0]!;
  const estimated = await h.service.estimateCost(jobId);
  await h.service.requestApproval(jobId);
  await h.service.approve(jobId, { estimateId: estimated.estimate!.id });
  const creative = (await h.store.getCampaign(campaign.id)).plan!.creatives[0]!;
  return { jobId, campaign, creative };
}

/** Ritmo (s/caractere) para a fala durar `seconds` com o roteiro do criativo mock. */
async function pace(seconds: number) {
  const probe = createHarness();
  const { creative } = await approved(probe);
  return seconds / spokenNarrationCharacters(creative);
}

describe("narração real (ElevenLabs com transporte falso)", () => {
  it("uma chamada, voz do perfil, custo REAL no ledger, timing salvo e legendas sincronizadas", async () => {
    const { h, http } = setup({ requestId: "req_narr_1" });
    const { jobId, creative } = await approved(h);
    const outcome = await h.service.generate(jobId);
    expect(outcome.kind).toBe("COMPLETED");

    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]!.url).toContain(ELEVENLABS_VOICES.rafael!.voiceId);
    const sent = String(http.calls[0]!.body.text);
    expect(sent.length).toBe(spokenNarrationCharacters(creative));

    const job = await h.store.getJob(jobId);
    const attempt = job.audioAttempts[0]!;
    expect(attempt).toMatchObject({ provider: "elevenlabs", model: "eleven_flash_v2_5", isMock: false, status: "succeeded", providerJobId: "req_narr_1" });
    expect(attempt.narration).toMatchObject({
      speakerProfileId: "rafael",
      requestId: "req_narr_1",
      inputCharacters: sent.length,
      providerCharacterCost: sent.length, // transporte falso ecoa o tamanho; na API real é outra unidade
      version: "v1",
      captionTiming: "alignment",
      language: "pt-BR",
    });
    expect(attempt.assetUri).toBe(`outputs/audio/${job.campaignId}/${job.creativeId}/v1/narration.mp3`);

    const audioCost = (await h.ledger.list({ jobId })).filter((e) => e.category === "audio");
    expect(audioCost).toHaveLength(1);
    expect(audioCost[0]).toMatchObject({ simulated: false, operation: "audio_generation", attemptId: attempt.id });
    expect(audioCost[0]!.costUsd).toBeCloseTo((sent.length / 1000) * 0.05, 8);

    const manifest = job.manifest!;
    expect(manifest.captionSource).toBe("alignment");
    expect(manifest.audio[0]).toMatchObject({ uri: attempt.assetUri, isMock: false });
    expect(manifest.captions.length).toBeGreaterThan(0);
    // Legendas com tempo REAL: a primeira começa em 0 (início da fala), não no início da cena.
    expect(manifest.captions[0]!.startSeconds).toBe(0);
    expect(JSON.stringify(job)).not.toContain(KEY);
  });

  it("narração muito mais longa: pede revisão, NÃO renderiza e NÃO regera sozinha; aceitar estende o fim", async () => {
    const { h, http } = setup({ secondsPerChar: await pace(40) });
    const { jobId } = await approved(h);
    const outcome = await h.service.generate(jobId);
    expect(outcome.kind).toBe("AUDIO_REVIEW");
    const job = await h.store.getJob(jobId);
    expect(job.status).toBe("audio_review");
    expect(job.audioAttempts[0]!.narration!.fit).toMatchObject({ status: "too_long", action: "review", measured: true });
    expect((h.renderer as MockRenderer).renderCalls).toHaveLength(0);
    expect(http.calls).toHaveLength(1);

    const accepted = await h.service.acceptNarration(jobId);
    expect((await accepted.completion).kind).toBe("COMPLETED");
    const done = await h.store.getJob(jobId);
    expect(done.audioAttempts[0]!.narration!.reviewAcceptedAt).toBeDefined();
    const fit = done.audioAttempts[0]!.narration!.fit!;
    expect(done.manifest!.duration).toBeCloseTo(25 + fit.extendSeconds, 3);
    expect(done.manifest!.extendedSeconds).toBeCloseTo(fit.extendSeconds, 3);
    expect(done.manifest!.warnings.map((w) => w.code)).toContain("timeline_extended");
    expect(http.calls).toHaveLength(1); // aceitar não chama nada pago
  });

  it("character-cost menor que o texto (caso real 169 → 85) NÃO reduz o custo: sem desconto duplicado", async () => {
    const { h } = setup({ characterCost: 85 });
    const { jobId, creative } = await approved(h);
    await h.service.generate(jobId);
    const job = await h.store.getJob(jobId);
    const chars = spokenNarrationCharacters(creative);
    expect(job.audioAttempts[0]!.narration).toMatchObject({ inputCharacters: chars, providerCharacterCost: 85 });
    const audio = (await h.ledger.list({ jobId })).find((e) => e.category === "audio")!;
    expect(audio.quantity).toBe(chars); // caracteres ENVIADOS, não o character-cost
    expect(audio.costUsd).toBeCloseTo((chars / 1000) * 0.05, 8);
  });

  it("excede pouco: estende o fim localmente, sem revisão e sem chamada extra", async () => {
    const { h, http } = setup({ secondsPerChar: await pace(26) });
    const { jobId } = await approved(h);
    expect((await h.service.generate(jobId)).kind).toBe("COMPLETED");
    const job = await h.store.getJob(jobId);
    expect(job.audioAttempts[0]!.narration!.fit).toMatchObject({ status: "too_long", action: "extend" });
    expect(job.manifest!.duration).toBeGreaterThan(26);
    expect(http.calls).toHaveLength(1);
  });

  it("gerar a narração de novo é explícito: nova versão, novo custo, anterior vira descartada (mas fica no total)", async () => {
    const { h, http } = setup();
    const { jobId } = await approved(h);
    await h.service.generate(jobId);

    const started = await h.service.startNarrationRegeneration(jobId);
    expect(started.kind).toBe("started");
    if (started.kind !== "started") return;
    expect((await started.completion).kind).toBe("COMPLETED");

    const job = await h.store.getJob(jobId);
    expect(http.calls).toHaveLength(2);
    expect(job.audioAttempts.map((a) => [a.narration?.version, a.active])).toEqual([["v1", false], ["v2", true]]);
    expect(discardedAttemptIds(job).has(job.audioAttempts[0]!.id)).toBe(true);
    const audio = (await h.ledger.list({ jobId })).filter((e) => e.category === "audio");
    expect(audio).toHaveLength(2);
    const report = await h.service.getJobCostReport(jobId);
    expect(report.actual.discardedBrl).toBeGreaterThan(0);
    expect(job.manifest!.audio[0]!.uri).toContain("/v2/");
  });

  it("orçamento excedido na regeneração: devolve a decisão e não chama nada", async () => {
    // Limite = total projetado da 1ª geração + 1 centavo: aprovar cabe, gerar a narração de novo não.
    const probe = setup();
    const p = await approved(probe.h);
    const projected = (await probe.h.store.getJob(p.jobId)).estimate!.projectedTotalBrl;
    const { h, http } = setup();
    const budget = { maxCostPerCreativeBrl: Math.round((projected + 0.01) * 100) / 100, maxCostPerCampaignBrl: 100, allowOverBudget: false };
    const { jobId } = await approved(h, budget);
    expect((await h.service.generate(jobId)).kind).toBe("COMPLETED");

    const result = await h.service.startNarrationRegeneration(jobId);
    expect(result.kind).toBe("BUDGET_EXCEEDED");
    expect(http.calls).toHaveLength(1);
    expect((await h.store.getJob(jobId)).status).toBe("completed");
  });

  it("limite de tentativas vale para a narração", async () => {
    const { h } = setup({}, { maxAttemptsPerScene: 1 });
    const { jobId } = await approved(h);
    await h.service.generate(jobId);
    await expect(h.service.startNarrationRegeneration(jobId)).rejects.toThrow(/tentativas/i);
  });

  it("falha da ElevenLabs: job falha, UMA chamada, nenhum retry pago e nenhum custo inventado", async () => {
    const { h, http } = setup({ status: 500 });
    const { jobId } = await approved(h);
    const outcome = await h.service.generate(jobId);
    expect(outcome.kind).toBe("FAILED");
    expect(http.calls).toHaveLength(1);
    const job = await h.store.getJob(jobId);
    expect(job.audioAttempts[0]).toMatchObject({ status: "failed", active: false, providerJobId: "req_1" });
    expect((await h.ledger.list({ jobId })).filter((e) => e.category === "audio")).toHaveLength(0);
    // Retomar exige nova estimativa e aprovação (D12).
    await expect(h.service.generate(jobId)).rejects.toThrow(UnexpectedStatusError);
  });

  it("falha na regeneração mantém a narração anterior e volta para completed", async () => {
    const fake = fakeElevenLabs();
    let fail = false;
    const transport = (url: string, init: RequestInit) =>
      fail ? Promise.resolve(new Response("{}", { status: 503, headers: { "request-id": "req_x" } })) : fake.transport(url, init);
    const h = createHarness({
      audioProvider: (pricing) => new ElevenLabsAudioProvider({ pricing, apiKey: KEY, voices: ELEVENLABS_VOICES, timeoutMs: 5_000, transport }),
    });
    const { jobId } = await approved(h);
    await h.service.generate(jobId);
    fail = true;
    const started = await h.service.startNarrationRegeneration(jobId);
    if (started.kind !== "started") throw new Error("esperava started");
    expect((await started.completion).kind).toBe("FAILED");
    const job = await h.store.getJob(jobId);
    expect(job.status).toBe("completed");
    expect(job.audioAttempts.map((a) => [a.status, a.active])).toEqual([["succeeded", true], ["failed", false]]);
  });

  it("corpo 200 inválido: tentativa falha, custo provável REGISTRADO", async () => {
    const { h } = setup({ invalidBody: true });
    const { jobId } = await approved(h);
    expect((await h.service.generate(jobId)).kind).toBe("FAILED");
    const audio = (await h.ledger.list({ jobId })).filter((e) => e.category === "audio");
    expect(audio).toHaveLength(1);
    expect(audio[0]!.simulated).toBe(false);
  });

  it("alinhamento que não confere → legendas estimadas, com aviso (nunca timing inventado)", async () => {
    const { h } = setup({ mismatchedAlignment: true });
    const { jobId } = await approved(h);
    expect((await h.service.generate(jobId)).kind).toBe("COMPLETED");
    const job = await h.store.getJob(jobId);
    expect(job.audioAttempts[0]!.narration).toMatchObject({ captionTiming: "estimated" });
    expect(job.audioAttempts[0]!.narration!.note).toMatch(/legendas estimadas/);
    expect(job.manifest!.captionSource).toBe("estimated");
    expect(job.manifest!.warnings.map((w) => w.code)).toContain("captions_estimated");
  });

  it("sem chave ElevenLabs: falha ANTES de qualquer chamada paga (nem vídeo)", async () => {
    const h = createHarness({ audioProvider: createAudioProviderFactory("elevenlabs", { ttsTimeoutMs: 1000 }) });
    const { jobId } = await approved(h);
    expect((await h.service.generate(jobId)).kind).toBe("FAILED");
    expect((await h.store.getJob(jobId)).error).toMatch(/ELEVENLABS_API_KEY/);
    expect(h.video.generateCalls).toHaveLength(0);
  });
});

describe("narração mock continua funcionando", () => {
  it("sem arquivo, sem timing, custo simulado e legendas estimadas (comportamento do Lote 3)", async () => {
    const h = createHarness();
    const { jobId } = await approved(h);
    expect((await h.service.generate(jobId)).kind).toBe("COMPLETED");
    const job = await h.store.getJob(jobId);
    expect(job.audioAttempts[0]).toMatchObject({ provider: "mock", isMock: true });
    expect(job.audioAttempts[0]!.narration).toMatchObject({ captionTiming: "estimated", speakerProfileId: "rafael" });
    expect(job.audioAttempts[0]!.narration!.version).toBeUndefined();
    expect(job.manifest!.captionSource).toBe("estimated");
    expect(job.manifest!.audio[0]!.isMock).toBe(true);
    expect((await h.ledger.list({ jobId })).find((e) => e.category === "audio")?.simulated).toBe(true);
    expect(h.audio.generateCalls[0]).toMatchObject({ speakerProfileId: "rafael", language: "pt-BR" });
  });
});

describe("armazenamento versionado da narração (disco)", () => {
  it("v1, v2… sem sobrescrever; timing e metadata sem segredo; leitura só dentro da pasta", async () => {
    const root = await mkdtemp(join(tmpdir(), "audio-assets-"));
    const store = new LocalAudioAssetStore(root);
    const { h } = setup({ requestId: "req_disk" }, { audioAssets: store });
    const { jobId } = await approved(h);
    await h.service.generate(jobId);
    const started = await h.service.startNarrationRegeneration(jobId);
    if (started.kind === "started") await started.completion;

    const job = await h.store.getJob(jobId);
    const dir = join(root, job.campaignId, job.creativeId);
    expect((await readdir(dir)).sort()).toEqual(["v1", "v2"]);
    expect((await readdir(join(dir, "v1"))).sort()).toEqual(["metadata.json", "narration.mp3", "timing.json"]);
    const metadata = await readFile(join(dir, "v1", "metadata.json"), "utf8");
    expect(JSON.parse(metadata)).toMatchObject({ version: "v1", provider: "elevenlabs", model: "eleven_flash_v2_5", speakerProfileId: "rafael" });
    expect(metadata).not.toContain(KEY);

    const timing = await store.readTiming(job.audioAttempts[1]!.narration!.timingUri!);
    expect(timing?.words.length).toBeGreaterThan(3);
    await expect(store.readTiming(`${root}/../segredo/timing.json`)).rejects.toBeInstanceOf(InvalidRenderPathError);
    await expect(store.readTiming("package.json")).rejects.toBeInstanceOf(InvalidRenderPathError);

    expect(await store.resolveNarrationFile({ campaignId: job.campaignId, creativeId: job.creativeId, version: "v2" })).toMatchObject({
      sizeBytes: expect.any(Number),
    });
    expect(await store.resolveNarrationFile({ campaignId: "..", creativeId: job.creativeId, version: "v1" })).toBeUndefined();
    expect(await store.resolveNarrationFile({ campaignId: job.campaignId, creativeId: job.creativeId, version: "../v1" })).toBeUndefined();
  });
});
