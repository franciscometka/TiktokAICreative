import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { RUNWAY_VIDEO } from "@/config/video-models";
import { LocalVideoAssetStore } from "@/storage/video-asset-store";
import { FilePipelineStore } from "@/storage/file-pipeline-store";
import { FileCostLedger } from "@/storage/file-cost-ledger";
import { InMemoryLlmCallLog } from "@/storage/llm-call-log";
import { RunwayVideoProvider } from "@/providers/video/runway-video-provider";
import { AssetResolver } from "@/render/asset-resolver";
import { buildCompositionProps } from "@/render/composition-props";
import { campaignRequest, createHarness, product, catalog } from "@/test/fixtures";
import { runwayFixture } from "@/test/runway-fake";

async function setup(options: Parameters<typeof runwayFixture>[0] = {}, storageFailure = false) {
  const fake = await runwayFixture(options);
  const store = new FilePipelineStore(join(fake.root, "data"));
  const ledger = new FileCostLedger(join(fake.root, "data"));
  const assets = new LocalVideoAssetStore(join(fake.root, "videos"));
  const h = createHarness({ storage: { store, ledger, llmCallLog: new InMemoryLlmCallLog() },
    videoChoice: RUNWAY_VIDEO, videoProvider: () => fake.provider,
    videoAssets: storageFailure ? { save: async () => { throw new Error("disco cheio"); } } : assets,
  });
  const campaign = await h.service.planCampaign(campaignRequest({ product: product({ images: [{ id: "img_1", uri: fake.request.referenceImageUris[0]! }] }) }));
  const jobId = campaign.jobIds[0]!;
  return { h, fake, jobId, campaign, assets };
}
async function approve(h: ReturnType<typeof createHarness>, jobId: string) {
  const job = await h.service.estimateCost(jobId);
  await h.service.requestApproval(jobId);
  expect((await h.service.approve(jobId, { estimateId: job.estimate!.id })).kind).toBe("APPROVED");
}
describe("Runway integrado ao pipeline sem internet", () => {
  it("exige aprovação, salva clipes versionados e custo real; recarrega do disco e renderiza assets reais", async () => {
    const { h, fake, jobId, assets } = await setup();
    await expect(h.service.generate(jobId)).rejects.toThrow();
    expect(fake.calls).toHaveLength(0);
    await approve(h, jobId);
    expect((await h.service.generate(jobId)).kind).toBe("COMPLETED");
    let job = await h.store.getJob(jobId);
    const entries = (await h.ledger.list({ jobId })).filter((e) => e.category === "video");
    expect(entries).toHaveLength(3);
    expect(entries.every((e) => !e.simulated)).toBe(true);
    expect(entries.reduce((n, e) => n + e.costUsd, 0)).toBeCloseTo(0.75);
    const uri = job.scenes[0]!.attempts[0]!.assetUri!;
    expect(uri).toContain("/v1/clip.mp4");
    expect(await readFile(uri)).toBeDefined();
    const reloaded = await new FilePipelineStore(join(fake.root, "data")).getJob(jobId);
    expect(reloaded).toEqual(job);
    expect(reloaded.videoTasks).toHaveLength(3);
    const resolved = new Map([[uri, await new AssetResolver([assets.rootDir]).resolve(uri)]]);
    const manifest = { ...job.manifest!, assets: job.manifest!.assets.map((a) => a.kind === "generated_video" ? { ...a, uri } : { ...a, uri: null }) };
    const built = buildCompositionProps({ manifest, assets: resolved, urlFor: () => "http://localhost/clip" });
    expect(built.props.scenes[0]!.video?.src).toBe("http://localhost/clip");
    expect(built.warnings.some((w) => w.code === "generated_video_placeholder")).toBe(false);
    expect(JSON.stringify(job)).not.toContain("secret-test-key");
    await h.service.regenerateScene(jobId, job.scenes[0]!.sceneId);
    job = await h.store.getJob(jobId);
    expect(job.scenes[0]!.attempts[0]!.active).toBe(false);
    expect(job.scenes[0]!.attempts[1]!.assetUri).toContain("/v2/clip.mp4");
    expect(await readFile(uri)).toBeDefined();
    expect((await h.ledger.list({ jobId })).filter((e) => e.category === "video")).toHaveLength(4);
  });
  it.each(["download", "storage"])("falha de %s mantém custo, tentativa e não repete POST", async (failure) => {
    const { h, fake, jobId } = await setup({ downloadFailure: failure === "download" }, failure === "storage");
    await approve(h, jobId);
    expect((await h.service.generate(jobId)).kind).toBe("FAILED");
    expect(fake.calls.filter((c) => c.init?.method === "POST")).toHaveLength(1);
    expect((await h.ledger.list({ jobId })).filter((e) => e.category === "video")).toMatchObject([{ simulated: false, costUsd: 0.25 }]);
    expect((await h.store.getJob(jobId)).scenes[0]!.attempts[0]).toMatchObject({ status: "failed", providerJobId: "task_1" });
  });
  it("chave ausente ou plano com modelo antigo não é executado silenciosamente", () => {
    const base = { pricing: catalog.requireOne(RUNWAY_VIDEO), uploadsDir: "outputs/uploads" };
    expect(() => new RunwayVideoProvider({ ...base, apiKey: "" })).toThrow(/não configurada/);
    expect(() => new RunwayVideoProvider({ ...base, apiKey: "x", pricing: catalog.requireOne({ provider: "unassigned-video", model: "economy-tier" }) })).toThrow(/nova campanha/);
  });
  it("polling limitado não repete POST e conserva task id após falha", async () => {
    const { h, fake, jobId } = await setup({ pending: true });
    await approve(h, jobId);
    expect((await h.service.generate(jobId)).kind).toBe("FAILED");
    expect(fake.calls.filter((c) => c.init?.method === "POST")).toHaveLength(1);
    expect(fake.calls.filter((c) => c.url.includes("/tasks/"))).toHaveLength(5);
    const job = await h.store.getJob(jobId);
    expect(job.videoTasks).toMatchObject([{ providerJobId: "task_1" }]);
    expect(job.scenes[0]!.attempts[0]!.providerJobId).toBe("task_1");
    expect((await h.ledger.list({ jobId })).filter((e) => e.category === "video")).toHaveLength(0);
  });
  it("orçamento insuficiente bloqueia a aprovação sem qualquer chamada Runway", async () => {
    const { h, fake, jobId, campaign } = await setup();
    await h.store.saveCampaign({ ...campaign, request: { ...campaign.request, budget: { maxCostPerCreativeBrl: 0.01, maxCostPerCampaignBrl: 0.01, allowOverBudget: false } } });
    const job = await h.service.estimateCost(jobId);
    await h.service.requestApproval(jobId);
    expect((await h.service.approve(jobId, { estimateId: job.estimate!.id })).kind).toBe("BUDGET_EXCEEDED");
    expect(fake.calls).toHaveLength(0);
  });

});


it("diagnóstico HTTP sobrevive à gravação e releitura do job", async () => {
  const { h, fake, jobId } = await setup({ response: () => Response.json({ message: "Not authorized", code: "unauthorized" }, { status: 401, headers: { "request-id": "req-persisted" } }) });
  await approve(h, jobId);
  expect((await h.service.generate(jobId)).kind).toBe("FAILED");
  const store = new FilePipelineStore(join(fake.root, "data"));
  const job = await store.getJob(jobId);
  expect(job.scenes[0]!.attempts[0]).toMatchObject({ providerJobId: null, diagnostic: { kind: "authentication", httpStatus: 401, requestId: "req-persisted", billing: "rejected" } });
  expect(await h.ledger.list({ jobId })).toHaveLength(0);
  expect(fake.calls).toHaveLength(1);
});


it("falha da tarefa preserva mensagem, request-id, consumo e diagnóstico no polling", async () => {
  let calls = 0;
  const { h, jobId } = await setup({ response: () => ++calls === 1 ? Response.json({ id: "failed-task" }) : Response.json({ id: "failed-task", status: "FAILED", failureCode: "INPUT_REJECTED", failure: "Image rejected secret-test-key", cost: { credits: 0 } }, { headers: { "x-request-id": "req-poll" } }) });
  await approve(h, jobId);
  expect((await h.service.generate(jobId)).kind).toBe("FAILED");
  const job = await h.store.getJob(jobId);
  expect(job.scenes[0]!.attempts[0]).toMatchObject({ providerJobId: "failed-task", diagnostic: { httpStatus: 200, requestId: "req-poll", providerCode: "INPUT_REJECTED", providerStatus: "FAILED", billing: "confirmed" } });
  expect(job.error).toContain("Image rejected [redigido]");
  expect(job.error).not.toContain("Possível cobrança");
  expect((await h.ledger.list({ jobId })).filter((e) => e.category === "video")).toMatchObject([{ costUsd: 0 }]);
  expect(calls).toBe(2);
});
