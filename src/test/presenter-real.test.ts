import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { randomId } from "@/lib/ids";
import { campaignRequest, createHarness } from "./fixtures";
import { fakeElevenLabs } from "./elevenlabs-fake";
import { wav } from "./presenter-fake";
import { FilePipelineStore } from "@/storage/file-pipeline-store";
import { FileCostLedger } from "@/storage/file-cost-ledger";
import { InMemoryLlmCallLog } from "@/storage/llm-call-log";
import { LocalAudioAssetStore } from "@/storage/audio-asset-store";
import { ElevenLabsAudioProvider } from "@/providers/audio/elevenlabs-audio-provider";
import { ELEVENLABS_VOICES } from "@/config/voices";
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "presenter-cli-"));
  const http = fakeElevenLabs({ secondsPerChar: 0.02 });
  const h = createHarness({ ids: randomId,
    storage: { store: new FilePipelineStore(join(root, "data")), ledger: new FileCostLedger(join(root, "data")), llmCallLog: new InMemoryLlmCallLog() },
    audioAssets: new LocalAudioAssetStore(join(root, "audio")),
    audioProvider: pricing => new ElevenLabsAudioProvider({ pricing, apiKey: "fake", voices: ELEVENLABS_VOICES, timeoutMs: 5000, transport: http.transport }),
  });
  const c = await h.service.planCampaign(campaignRequest()); const jobId = c.jobIds[0]!;
  const estimate = await h.service.estimateCost(jobId); await h.service.requestApproval(jobId); await h.service.approve(jobId, { estimateId: estimate.estimate!.id });
  await h.service.generate(jobId); const job = await h.service.getJob(jobId);
  // Decodable PCM asset isolates the CLI from external TTS generation.
  await writeFile(job.audioAttempts[0]!.assetUri!, wav(job.audioAttempts[0]!.durationSeconds!));
  const env = { ...process.env, DATA_DIR: join(root, "data"), AUDIO_DIR: join(root, "audio"), VIDEOS_DIR: join(root, "videos"), RUNWAYML_API_SECRET: "", LLM_PROVIDER: "mock", AUDIO_PROVIDER: "mock", VIDEO_PROVIDER: "mock" };
  return { root, h, jobId, env, job };
}
describe("presenter:real offline", () => {
  it("dry-run não precisa de chave, não chama rede nem grava campanha", async () => {
    const f = await setup(); const before = await readdir(join(f.root, "data", "jobs"));
    const hook = join(f.root, "no-network.mjs"); await writeFile(hook, 'globalThis.fetch = async () => { throw new Error("Network forbidden"); };');
    const out = execFileSync(process.execPath, ["--import", pathToFileURL(hook).href, "--import", "tsx", "scripts/presenter-real.ts", "--job", f.jobId, "--avatar", "human-resource"], { encoding: "utf8", env: f.env, timeout: 30000 });
    expect(out).toContain("Dry-run"); expect(out).toContain("gwm1_avatars"); expect(out).toContain("human-resource"); expect(out).toContain("narration.mp3"); expect(out).toContain("intervalo");
    expect(await readdir(join(f.root, "data", "jobs"))).toEqual(before);
  }, 35_000);
  it("--confirm não cria campanha nem chama avatar enquanto o bloqueio está ativo", async () => {
    const f = await setup();
    const before = await readFile(join(f.root, "data", "jobs", `${f.jobId}.json`), "utf8");
    let errorText = "";
    try { execFileSync(process.execPath, ["--import", "tsx", "scripts/presenter-real.ts", "--job", f.jobId, "--avatar", "influencer", "--confirm"], { stdio: "pipe", encoding: "utf8", env: { ...f.env, RUNWAYML_API_SECRET: "fake-key" }, timeout: 30000 }); }
    catch (error) { errorText = String((error as { stderr?: string }).stderr ?? ""); }
    expect(errorText).toContain("reais/pagas bloqueadas");
    expect(await readFile(join(f.root, "data", "jobs", `${f.jobId}.json`), "utf8")).toBe(before);
    expect(await readdir(join(f.root, "data", "jobs"))).toHaveLength(1);
  }, 35000);
  it("flags inválidas não autorizam geração", () => {
    expect(() => execFileSync(process.execPath, ["--import", "tsx", "scripts/presenter-real.ts", "--confirmed"], { stdio: "pipe", timeout: 30000 })).toThrow();
  }, 35_000);
  it("retomada sem --confirm também não chama a rede nem grava estado", async () => {
    const f = await setup(); const preview = await f.h.service.previewPresenterValidation(f.jobId, "influencer");
    await f.h.store.saveJob({ ...f.job, presenterTasks: [{ attemptId: "pending_test", sceneId: preview.sceneId, avatarPresetId: "influencer", state: "pending", providerJobId: "existing_task",
      requestedDurationSeconds: preview.durationSeconds, audio: preview.audio, estimatedCostUsd: preview.estimate.costUsd, createdAt: f.job.createdAt }] });
    const file = join(f.root, "data", "jobs", `${f.jobId}.json`); const before = await readFile(file, "utf8");
    const hook = join(f.root, "resume-no-network.mjs"); await writeFile(hook, 'globalThis.fetch = async () => { throw new Error("Network forbidden"); };');
    const out = execFileSync(process.execPath, ["--import", pathToFileURL(hook).href, "--import", "tsx", "scripts/presenter-real.ts", "--job", f.jobId, "--resume"], { encoding: "utf8", env: f.env, timeout: 30000 });
    expect(out).toContain("Dry-run de retomada"); expect(out).toContain("existing_task");
    expect(await readFile(file, "utf8")).toBe(before);
  }, 35_000);
});
