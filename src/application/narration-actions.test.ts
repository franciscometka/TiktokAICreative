import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ELEVENLABS_VOICES } from "@/config/voices";
import { ElevenLabsAudioProvider } from "@/providers/audio/elevenlabs-audio-provider";
import { LocalAudioAssetStore } from "@/storage/audio-asset-store";
import { formInput, GatedPlanner, settle, tempUploads, until } from "@/test/app-fixtures";
import { fakeElevenLabs, type FakeElevenLabsOptions } from "@/test/elevenlabs-fake";
import { createHarness } from "@/test/fixtures";
import {
  acceptNarration,
  approveCreative,
  getCampaignView,
  regenerateNarration,
  resolveNarrationFile,
  startCampaignPlanning,
  type AppDeps,
} from "./campaign-actions";
import type { CampaignView } from "./campaign-view";

const KEY = "sk_test_view_0000";

function ok<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(`esperava sucesso: ${JSON.stringify(result.error)}`);
  return result.value;
}

async function setup(options: { real?: boolean; fake?: FakeElevenLabsOptions; speakerProfileId?: string } = {}) {
  const audioDir = await mkdtemp(join(tmpdir(), "narr-app-"));
  const http = fakeElevenLabs(options.fake);
  let planner!: GatedPlanner;
  const real = options.real ?? true;
  const h = createHarness({
    planner: (gen) => (planner = new GatedPlanner(gen)),
    audioAssets: new LocalAudioAssetStore(audioDir),
    audioProvider: real
      ? (pricing) => new ElevenLabsAudioProvider({ pricing, apiKey: KEY, voices: ELEVENLABS_VOICES, timeoutMs: 5000, transport: http.transport })
      : undefined,
  });
  const { uploads } = await tempUploads();
  const deps: AppDeps = { service: h.service, uploads, rendersDir: "outputs/renders", audioDir, audioProvider: real ? "elevenlabs" : "mock" };
  const { campaignId } = ok(await startCampaignPlanning(deps, formInput({ speakerProfileId: options.speakerProfileId })));
  planner.release();
  await settle();
  const view = async (): Promise<CampaignView> => ok(await getCampaignView(deps, campaignId));
  return { h, http, deps, campaignId, view };
}

async function approveFirst(ctx: Awaited<ReturnType<typeof setup>>, status = "completed") {
  const c = (await ctx.view()).creatives[0]!;
  ok(await approveCreative(ctx.deps, { jobId: c.jobId!, estimateId: c.estimate!.estimateId }));
  await until(async () => (await ctx.view()).creatives[0]?.jobStatus === status);
  return (await ctx.view()).creatives[0]!;
}

describe("narração na interface", () => {
  it("antes de aprovar: voz escolhida, provider real, custo estimado, nada gasto", async () => {
    const ctx = await setup({ speakerProfileId: "bia" });
    const n = (await ctx.view()).creatives[0]!.narration;
    expect(n).toMatchObject({
      speaker: { id: "bia", name: "Bia" },
      provider: "elevenlabs",
      providerLabel: "Narração real · ElevenLabs",
      isReal: true,
      status: "pending",
      actualBrl: null,
      model: "eleven_flash_v2_5",
      canRegenerate: false,
    });
    expect(n.estimatedBrl).toBeGreaterThan(0);
    expect(ctx.http.calls).toHaveLength(0);
    expect(JSON.stringify(n)).not.toContain(ELEVENLABS_VOICES.bia!.voiceId);
  });

  it("mock: rótulo MODO DE TESTE, custo simulado, sem player", async () => {
    const ctx = await setup({ real: false });
    const c = await approveFirst(ctx);
    expect(c.narration).toMatchObject({ providerLabel: "MODO DE TESTE", isReal: false, actualSimulated: true, audioUrl: null, status: "ready" });
  });

  it("depois de gerar: custo real, status, legendas sincronizadas e player por ID (sem caminho)", async () => {
    const ctx = await setup();
    const c = await approveFirst(ctx);
    const n = c.narration;
    expect(n).toMatchObject({ status: "ready", statusLabel: "Gerada", captionTiming: "alignment", version: "v1", actualSimulated: false, canRegenerate: true });
    expect(n.actualBrl).toBeGreaterThan(0);
    expect(n.audioUrl).toBe(`/api/audio/${ctx.campaignId}/${c.id}/v1`);
    expect(JSON.stringify(n)).not.toMatch(/narr-app-|narration\.mp3/);

    const file = await resolveNarrationFile(ctx.deps, { campaignId: ctx.campaignId, creativeId: c.id, version: "v1" });
    expect(file).toMatchObject({ fileName: `narracao-${c.id}-v1.mp3` });
    expect(file!.sizeBytes).toBeGreaterThan(400);
  });

  it.each([
    ["..", "c", "v1"],
    ["campaign_x", "../..", "v1"],
    ["campaign_x", "c", "../v1"],
    ["campaign_x", "c", "v0"],
  ])("resolveNarrationFile recusa IDs inválidos (%s/%s/%s)", async (campaignId, creativeId, version) => {
    const ctx = await setup({ real: false });
    expect(await resolveNarrationFile(ctx.deps, { campaignId, creativeId, version })).toBeUndefined();
  });

  it("versão não registrada no job não é servida, mesmo se existir no disco", async () => {
    const ctx = await setup();
    const c = await approveFirst(ctx);
    expect(await resolveNarrationFile(ctx.deps, { campaignId: ctx.campaignId, creativeId: c.id, version: "v7" })).toBeUndefined();
  });

  it("revisão de duração: botões aceitar/gerar de novo; aceitar renderiza sem nova chamada", async () => {
    const ctx = await setup({ fake: { secondsPerChar: 0.2 } });
    const c = await approveFirst(ctx, "audio_review");
    expect(c.jobStatusLabel).toBe("Revisar narração");
    expect(c.narration).toMatchObject({ status: "review", canAccept: true, canRegenerate: true });
    expect(c.narration.fit).toMatchObject({ status: "too_long", action: "review" });
    expect(c.canCancel).toBe(true);

    expect(ok(await acceptNarration(ctx.deps, c.jobId!))).toEqual({ kind: "started" });
    await until(async () => (await ctx.view()).creatives[0]?.jobStatus === "completed");
    expect(ctx.http.calls).toHaveLength(1);
  });

  it("gerar narração de novo pela action: nova versão e novo custo", async () => {
    const ctx = await setup();
    const c = await approveFirst(ctx);
    const before = c.narration.actualBrl!;
    expect(ok(await regenerateNarration(ctx.deps, { jobId: c.jobId! }))).toEqual({ kind: "started" });
    await until(async () => (await ctx.view()).creatives[0]?.narration.version === "v2");
    const n = (await ctx.view()).creatives[0]!.narration;
    expect(n.attempts).toBe(2);
    expect(n.actualBrl!).toBeGreaterThan(before);
    expect(ctx.http.calls).toHaveLength(2);
  });

  it("falha mostra o erro e não re-tenta", async () => {
    const ctx = await setup({ fake: { status: 429 } });
    const c = await approveFirst(ctx, "failed");
    expect(c.narration.status).toBe("failed");
    expect(c.narration.lastError).toMatch(/429/);
    expect(ctx.http.calls).toHaveLength(1);
  });
});
