import { randomId } from "@/lib/ids";
import { describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { campaignRequest, createHarness } from "@/test/fixtures";
import { fakeElevenLabs } from "@/test/elevenlabs-fake";
import { fakePresenter, wav } from "@/test/presenter-fake";
import { ElevenLabsAudioProvider } from "@/providers/audio/elevenlabs-audio-provider";
import { RunwayPresenterProvider } from "@/providers/presenter/runway-presenter-provider";
import { ELEVENLABS_VOICES } from "@/config/voices";
import { LocalAudioAssetStore } from "@/storage/audio-asset-store";
import { LocalVideoAssetStore } from "@/storage/video-asset-store";
import { FilePipelineStore } from "@/storage/file-pipeline-store";
import { FileCostLedger } from "@/storage/file-cost-ledger";
import { InMemoryLlmCallLog } from "@/storage/llm-call-log";
import { alignedSceneWindows } from "@/speech/presenter-audio";
import { discardedAttemptIds } from "./guards";
import { resolveSceneVideoFile } from "@/application/campaign-actions";
import { LocalUploadStore } from "@/storage/upload-store";
async function setup(options: Parameters<typeof fakePresenter>[0] = {}, audioOptions: Parameters<typeof fakeElevenLabs>[0] = {}) {
  const root = await mkdtemp(join(tmpdir(), "presenter-flow-"));
  const audio = fakeElevenLabs({ secondsPerChar: 0.02, ...audioOptions });
  const http = fakePresenter(options);
  const slices: { path: string; startSeconds: number; endSeconds: number }[] = [];
  const build = () => createHarness({
    ids: randomId,
    storage: { store: new FilePipelineStore(join(root, "data")), ledger: new FileCostLedger(join(root, "data")), llmCallLog: new InMemoryLlmCallLog() },
    audioAssets: new LocalAudioAssetStore(join(root, "audio")), videoAssets: new LocalVideoAssetStore(join(root, "videos")),
    audioProvider: pricing => new ElevenLabsAudioProvider({ pricing, apiKey: "fake-elevenlabs-key", voices: ELEVENLABS_VOICES, timeoutMs: 5000, transport: audio.transport }),
    presenterProvider: pricing => new RunwayPresenterProvider({ pricing, apiKey: "secret-avatar-key", transport: http.transport }),
    presenterAudioSlicer: async (path, window) => { slices.push({ path, ...window }); return wav(window.endSeconds - window.startSeconds); },
  });
  const h = build();
  const campaign = await h.service.planCampaign(campaignRequest({ presenterPresetId: "influencer" }));
  const jobId = campaign.jobIds[0]!;
  const scene = campaign.plan!.creatives[0]!.scenes.find(s => s.visualSource === "presenter")!;
  async function approve() {
    const job = await h.service.estimateCost(jobId); await h.service.requestApproval(jobId);
    expect((await h.service.approve(jobId, { estimateId: job.estimate!.id })).kind).toBe("APPROVED");
  }
  return { root, h, audio, http, slices, campaign, jobId, scene, approve, build };
}
describe("presenter real — transportes inteiramente falsos", () => {
  it("exige aprovação antes de áudio e avatar; usa preço específico de presenter", async () => {
    const f = await setup();
    await expect(f.h.service.generate(f.jobId)).rejects.toThrow();
    expect(f.http.calls).toHaveLength(0); expect(f.audio.calls).toHaveLength(0);
    const job = await f.h.service.estimateCost(f.jobId);
    expect(job.estimate!.breakdown.find(l => l.sceneId === f.scene.id)?.model).toBe("gwm1_avatars");
  });
  it("reutiliza UMA narração/alignment, envia só o trecho, persiste IDs, valida e renderiza alinhado", async () => {
    const f = await setup(); await f.approve();
    expect((await f.h.service.generate(f.jobId)).kind).toBe("COMPLETED");
    expect(f.audio.calls).toHaveLength(1); expect(f.http.posts).toBe(1);
    const post = f.http.calls.find(c => c.body)!.body!;
    expect(post).toMatchObject({ model: "gwm1_avatars", avatar: { type: "runway-preset", presetId: "influencer" }, speech: { type: "audio" } });
    expect(JSON.stringify(post)).not.toContain('"voice"'); expect(JSON.stringify(post)).not.toContain('"text"');
    const job = await f.h.service.getJob(f.jobId); const task = job.presenterTasks![0]!;
    const narration = job.audioAttempts[0]!;
    const timing = (await f.h.audioAssets.readTiming(narration.narration!.timingUri!))!;
    const windows = alignedSceneWindows(f.campaign.plan!.creatives[0]!, timing, narration.durationSeconds!);
    expect(task.audio).toMatchObject({ narrationAttemptId: narration.id, ...windows[f.scene.order] });
    expect(f.slices[0]).toMatchObject(windows[f.scene.order]!);
    const attempt = job.scenes.find(s => s.sceneId === f.scene.id)!.attempts[0]!;
    expect(attempt).toMatchObject({ providerJobId: "avatar_1", requestId: "req-avatar-1", status: "succeeded", media: { status: "valid" } });
    const duration = windows[f.scene.order]!.endSeconds - windows[f.scene.order]!.startSeconds;
    expect(attempt.media!.actualMediaDurationSeconds).toBeCloseTo(duration, 2);
    expect(task.actualCostUsd).toBeCloseTo(Math.ceil(duration/3)*0.01, 6);
    expect(job.manifest!.assets[f.scene.order]!.durationSeconds).toBeCloseTo(duration, 3);
    expect(job.manifest!.duration).toBeCloseTo(narration.durationSeconds!, 3);
    const metadata = JSON.parse(await readFile(join(attempt.assetUri!, "..", "metadata.json"), "utf8"));
    expect(metadata).toMatchObject({ requestId: "req-avatar-1", avatarPresetId: "influencer", audio: task.audio });
    const cdn = f.http.calls.find(c => c.url.endsWith("avatar.mp4"))!; expect(cdn.headers).toBeUndefined();
    expect(JSON.stringify(job)).not.toContain("secret-avatar-key");
  });
  it("timeout de polling retoma com provider e stores novos: mesmo ID, sem POST ou voz duplicados", async () => {
    const f = await setup({ pending: true }); await f.approve();
    expect((await f.h.service.generate(f.jobId)).kind).toBe("FAILED");
    expect((await f.h.service.getJob(f.jobId)).status).toBe("generating");
    expect(f.http.posts).toBe(1);
    f.http.options.pending = false;
    const restarted = f.build();
    const resumed = await (await restarted.service.startRerender(f.jobId)).completion;
    expect(resumed, JSON.stringify(resumed)).toMatchObject({ kind: "COMPLETED" });
    expect(f.http.posts).toBe(1); expect(f.audio.calls).toHaveLength(1);
    expect((await restarted.ledger.list({ jobId: f.jobId })).filter(e => e.model === "gwm1_avatars")).toHaveLength(1);
  });
  it("envio incerto/timeout sem ID nunca repete POST após restart", async () => {
    const f = await setup({ timeout: true }); await f.approve();
    expect((await f.h.service.generate(f.jobId)).kind).toBe("FAILED");
    expect((await f.h.service.getJob(f.jobId)).presenterTasks![0]!.state).toBe("submitting");
    f.http.options.timeout = false;
    const restarted = f.build();
    const result = await (await restarted.service.startRerender(f.jobId)).completion;
    expect(result.kind).toBe("FAILED"); expect(f.http.posts).toBe(1);
    expect(JSON.stringify(await restarted.service.getJob(f.jobId))).not.toMatch(/secret-avatar-key|PRIVATE/);
  });
  it("retomada após ledger gravado não duplica custo nem reenvia geração", async () => {
    const f = await setup(); await f.approve(); await f.h.service.generate(f.jobId);
    const done = await f.h.service.getJob(f.jobId);
    // Reproduce a crash between cost persistence and the final successful attempt save.
    await f.h.store.saveJob({ ...done, status: "generating", manifest: undefined, outputUri: undefined, renders: [],
      presenterTasks: done.presenterTasks!.map(t => ({ ...t, state: "pending" })),
      scenes: done.scenes.map(s => s.sceneId === f.scene.id ? { ...s, attempts: [] } : s) });
    const restarted = f.build();
    expect((await (await restarted.service.startRerender(f.jobId)).completion).kind).toBe("COMPLETED");
    expect((await restarted.ledger.list({ jobId: f.jobId })).filter(e => e.model === "gwm1_avatars")).toHaveLength(1);
    expect(f.http.posts).toBe(1); expect(f.audio.calls).toHaveLength(1);
    const recovered = await restarted.service.getJob(f.jobId);
    expect(recovered.scenes.find(s => s.sceneId === f.scene.id)!.attempts[0]!.assetUri).toContain("/v2/");
  });
  it.each(["short", "badDownload", "failed"] as const)("falha %s mantém custo e bloqueia render sem retry", async option => {
    const f = await setup({ [option]: true }); await f.approve();
    expect((await f.h.service.generate(f.jobId)).kind).toBe("FAILED");
    const job = await f.h.service.getJob(f.jobId);
    expect(job.scenes.find(s => s.sceneId === f.scene.id)!.attempts[0]!.active).toBe(false);
    expect((await f.h.ledger.list({ jobId: f.jobId })).filter(e => e.model === "gwm1_avatars")).toHaveLength(1);
    expect(job.manifest).toBeUndefined(); expect(f.http.posts).toBe(1);
  });
  it("HTTP 429 sanitiza áudio/chave e preserva diagnóstico sem supor cobrança", async () => {
    const f = await setup({ reject: true }); await f.approve();
    await f.h.service.generate(f.jobId);
    const job = await f.h.service.getJob(f.jobId);
    const attempt = job.scenes.find(s => s.sceneId === f.scene.id)!.attempts[0]!;
    expect(attempt.diagnostic).toMatchObject({ httpStatus: 429, requestId: "req-rejected", billing: "rejected" });
    expect(JSON.stringify(job)).not.toMatch(/secret-avatar-key|data:audio/);
    expect((await f.h.ledger.list({ jobId: f.jobId })).filter(e => e.model === "gwm1_avatars")).toHaveLength(0);
  });
  it("sem alignment não usa timing estimado para lip sync", async () => {
    const f = await setup({}, { omitAlignment: true }); await f.approve();
    expect((await f.h.service.generate(f.jobId)).kind).toBe("FAILED"); expect(f.http.posts).toBe(0);
  });
  it("regeneração explícita preserva v1, cria v2, descarta custo antigo e não chama TTS", async () => {
    const f = await setup(); await f.approve(); await f.h.service.generate(f.jobId);
    const first = await f.h.service.getJob(f.jobId);
    const uri = first.scenes.find(s => s.sceneId === f.scene.id)!.attempts[0]!.assetUri!;
    expect((await f.h.service.regenerateScene(f.jobId, f.scene.id)).kind).toBe("REGENERATED");
    const job = await f.h.service.getJob(f.jobId); const attempts = job.scenes.find(s => s.sceneId === f.scene.id)!.attempts;
    expect(attempts).toHaveLength(2); expect(attempts[0]!.active).toBe(false); expect(attempts[1]!.assetUri).toContain("/v2/");
    expect(await readFile(uri)).toBeDefined(); expect(discardedAttemptIds(job)).toContain(attempts[0]!.id);
    expect(f.http.posts).toBe(2); expect(f.audio.calls).toHaveLength(1);
    const deps = { service: f.h.service, videosDir: join(f.root, "videos"), audioDir: join(f.root, "audio"), rendersDir: join(f.root, "renders"), uploads: new LocalUploadStore(join(f.root, "uploads")) };
    const ids = { campaignId: job.campaignId, creativeId: job.creativeId, sceneId: f.scene.id, version: "v1" };
    expect(await resolveSceneVideoFile(deps, ids)).toBeDefined();
    expect(await resolveSceneVideoFile(deps, { ...ids, sceneId: "../private" })).toBeUndefined();
    expect(await resolveSceneVideoFile(deps, { ...ids, version: "v99" })).toBeUndefined();
    await expect(f.h.service.startNarrationRegeneration(f.jobId)).rejects.toThrow(/sincronizado/);
  });
  it("duração informada divergente é auditada; prevalece MP4 salvo", async () => {
    const f = await setup({ reportedDuration: 20 }); await f.approve(); await f.h.service.generate(f.jobId);
    const job = await f.h.service.getJob(f.jobId);
    expect(job.scenes.find(s => s.sceneId === f.scene.id)!.attempts[0]!.media).toMatchObject({ status: "valid", providerReportedDurationSeconds: 20, providerMismatch: true });
  });
  it("nova aprovação após falha permite retry explícito e mantém as duas cobranças", async () => {
    const f = await setup({ short: true }); await f.approve();
    expect((await f.h.service.generate(f.jobId)).kind).toBe("FAILED");
    f.http.options.short = false;
    await f.approve();
    expect((await f.h.service.generate(f.jobId)).kind).toBe("COMPLETED");
    const job = await f.h.service.getJob(f.jobId);
    const attempts = job.scenes.find(s => s.sceneId === f.scene.id)!.attempts;
    expect(attempts.map(a => a.status)).toEqual(["failed", "succeeded"]);
    expect(job.presenterTasks).toHaveLength(2);
    expect(f.http.posts).toBe(2); expect(f.audio.calls).toHaveLength(1);
    expect((await f.h.ledger.list({ jobId: f.jobId })).filter(e => e.model === "gwm1_avatars")).toHaveLength(2);
  });
  it("regeneração acima do orçamento não envia novo POST", async () => {
    const f = await setup(); await f.approve(); await f.h.service.generate(f.jobId);
    const campaign = await f.h.store.getCampaign(f.campaign.id);
    await f.h.store.saveCampaign({ ...campaign, request: { ...campaign.request, budget: { maxCostPerCreativeBrl: 0.001, maxCostPerCampaignBrl: 0.001, allowOverBudget: false } } });
    expect((await f.h.service.regenerateScene(f.jobId, f.scene.id)).kind).toBe("BUDGET_EXCEEDED");
    expect(f.http.posts).toBe(1); expect(f.audio.calls).toHaveLength(1);
  });
  it("falha de regeneração preserva o presenter anterior e seu preview", async () => {
    const f = await setup(); await f.approve(); await f.h.service.generate(f.jobId);
    const before = await f.h.service.getJob(f.jobId);
    const previous = before.scenes.find(s => s.sceneId === f.scene.id)!.attempts[0]!;
    f.http.options.short = true;
    expect((await f.h.service.regenerateScene(f.jobId, f.scene.id)).kind).toBe("FAILED");
    const after = await f.h.service.getJob(f.jobId);
    expect(after.status).toBe("completed");
    expect(after.scenes.find(s => s.sceneId === f.scene.id)!.attempts.find(a => a.active)?.assetUri).toBe(previous.assetUri);
    expect(f.audio.calls).toHaveLength(1);
  });
});
