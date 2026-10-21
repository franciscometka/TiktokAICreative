import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GenerationJob } from "@/domain/pipeline";
import { PNG_BYTES } from "@/test/app-fixtures";
import { cloudHarness, type CloudHarness } from "@/test/cloud-harness";
import { TEST_USER } from "@/test/pglite";
import { PostgresPipelineStore } from "../repos/pipeline-repository";
import { finishForOutcome } from "./worker";

let h: CloudHarness;
beforeAll(async () => { h = await cloudHarness(); });
afterAll(async () => { await h.close(); });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Projeto planejado e pronto para "Gerar vídeo" (planejamento mock pelo worker). */
async function plannedProject(ownerId: string): Promise<{ campaignId: string; jobId: string; token: string }> {
  const auth = await h.call("POST", "/v1/uploads/authorize", { body: { ownerId, contentType: "image/png", size: PNG_BYTES.length } });
  await fetch(auth.json.value.uploadUrl, { method: "PUT", headers: { "Content-Type": "image/png" }, body: PNG_BYTES });
  const done = await h.call("POST", "/v1/uploads/complete", { body: { ownerId, imageId: auth.json.value.imageId } });
  const created = await h.call("POST", "/v1/projects", { body: { productId: ownerId, name: "Secador Pro", imageIds: [done.json.value.id], idea: "Apresentação natural do secador no quarto.", duration: 30 } });
  const campaignId = created.json.value.campaignId as string;
  await h.drain();
  const v2 = (await h.call("GET", `/v1/projects/${campaignId}`)).json.value.v2;
  return { campaignId, jobId: v2.jobId, token: v2.quoteToken };
}

describe("fila durável (claim transacional)", () => {
  it("dedupe: a mesma chave ativa não cria segunda tarefa", async () => {
    const { campaignId } = await plannedProject("prod_q1");
    const input = { userId: TEST_USER, campaignId, jobId: null, payload: { kind: "planning" as const, planningRunId: "x", realAuthorized: false }, paid: false, dedupeKey: "test:dedupe" };
    const a = await h.infra.queue.enqueue(input);
    const b = await h.infra.queue.enqueue(input);
    expect(a.created).toBe(true);
    expect(b).toMatchObject({ created: false, task: { id: a.task.id } });
    await h.db.query("update job_queue set status = 'completed' where id = $1", [a.task.id]);
  });

  it("dois workers nunca pegam a mesma tarefa; uma tarefa running por campanha", async () => {
    const { campaignId } = await plannedProject("prod_q2");
    const base = { userId: TEST_USER, campaignId, jobId: null, payload: { kind: "planning" as const, planningRunId: "x", realAuthorized: false }, paid: false };
    await h.infra.queue.enqueue({ ...base, dedupeKey: "test:race:1" });
    await h.infra.queue.enqueue({ ...base, dedupeKey: "test:race:2" });
    const [w1, w2] = await Promise.all([h.infra.queue.claim("w1", 30), h.infra.queue.claim("w2", 30)]);
    const claimed = [w1, w2].filter(Boolean);
    expect(claimed).toHaveLength(1);
    // A segunda tarefa da MESMA campanha espera a primeira terminar.
    expect(await h.infra.queue.claim("w3", 30)).toBeUndefined();
    const owner = claimed[0]!.lockedBy!;
    expect(await h.infra.queue.finish(claimed[0]!.id, owner === "w1" ? "w2" : "w1", { status: "completed", outcome: "x" })).toBe(false); // só o dono encerra
    expect(await h.infra.queue.finish(claimed[0]!.id, owner, { status: "completed", outcome: "x" })).toBe(true);
    const next = await h.infra.queue.claim("w3", 30);
    expect(next?.dedupeKey).toBe(claimed[0]!.dedupeKey === "test:race:1" ? "test:race:2" : "test:race:1");
    await h.infra.queue.finish(next!.id, "w3", { status: "completed", outcome: "x" });
  });
});

describe("restart do worker", () => {
  it("operação paga em voo + worker morto → blocked, sem novo POST; o resto da fila segue", async () => {
    const { jobId, token } = await plannedProject("prod_r1");
    expect((await h.call("POST", `/v1/jobs/${jobId}/generate`, { body: { token } })).status).toBe(202);
    // Worker A pega a tarefa, grava a intenção paga (antes do POST) e morre sem responder.
    const task = await h.infra.queue.claim("dead-worker", 1);
    expect(task?.jobId).toBe(jobId);
    const store = new PostgresPipelineStore(h.db, TEST_USER);
    const job = await store.getJob(jobId);
    await store.saveJob({ ...job, currentStage: "ugc_reference", stageIntents: [{ stage: "ugc_reference", unit: "1 referência", state: "running", createdAt: new Date().toISOString() }] } as GenerationJob);
    const referencesBefore = (await store.getJob(jobId)).ugc?.references.length ?? 0;
    await sleep(1_300);

    const b = h.worker("worker-b");
    expect(await b.recoverExpired()).toBe(1);
    const row = (await h.db.query<{ status: string; blocked_reason: string }>("select status, blocked_reason from job_queue where id = $1", [task!.id])).rows[0];
    expect(row?.status).toBe("blocked");
    expect(row?.blocked_reason).toMatch(/Nada foi reenviado/);
    expect(await b.tick()).toBe("idle"); // nada foi reenfileirado
    expect((await store.getJob(jobId)).ugc?.references.length ?? 0).toBe(referencesBefore);
    const status = await h.call("GET", `/v1/jobs/${jobId}`);
    expect(status.json.value).toMatchObject({ progress: "blocked", task: { status: "blocked" } });
    // O worker morto "acorda": não consegue mais escrever na tarefa recuperada.
    expect(await h.infra.queue.heartbeat(task!.id, "dead-worker", 30)).toBe(false);
    expect(await h.infra.queue.finish(task!.id, "dead-worker", { status: "completed", outcome: "late" })).toBe(false);
  });

  it("sem operação paga em voo → volta para a fila e o novo worker continua a sequência aprovada", async () => {
    const { jobId, token } = await plannedProject("prod_r2");
    await h.call("POST", `/v1/jobs/${jobId}/generate`, { body: { token } });
    const task = await h.infra.queue.claim("dead-worker-2", 1);
    expect(task).toBeDefined();
    await sleep(1_300);
    const b = h.worker("worker-c");
    expect(await b.recoverExpired()).toBe(1);
    expect((await h.db.query<{ status: string }>("select status from job_queue where id = $1", [task!.id])).rows[0]?.status).toBe("queued");
    await h.drain(b);
    expect((await h.call("GET", `/v1/jobs/${jobId}`)).json.value.progress).toBe("awaiting_reference_approval");
  });

  it("planejamento pago interrompido nunca é refeito sozinho", async () => {
    const { campaignId } = await plannedProject("prod_r3");
    await h.infra.queue.enqueue({ userId: TEST_USER, campaignId, jobId: null, payload: { kind: "planning", planningRunId: "run_x", realAuthorized: true }, paid: true, dedupeKey: `planning:${campaignId}:paid` });
    const task = await h.infra.queue.claim("dead-worker-3", 1);
    await sleep(1_300);
    await h.worker("worker-d").recoverExpired();
    expect((await h.db.query<{ status: string }>("select status from job_queue where id = $1", [task!.id])).rows[0]?.status).toBe("blocked");
  });

  it("desfecho com intenção paga pendente vira blocked/uncertain (nunca auto-retry)", () => {
    const job = { status: "generating", stageIntents: [{ stage: "ugc_video", unit: "1 trecho", state: "running", createdAt: "t" }] } as unknown as GenerationJob;
    expect(finishForOutcome({ kind: "WAITING_STAGE", job })).toMatchObject({ status: "blocked", outcome: "uncertain" });
    expect(finishForOutcome({ kind: "WAITING_STAGE", job: { ...job, stageIntents: [] } })).toMatchObject({ status: "awaiting_approval" });
    expect(finishForOutcome({ kind: "FAILED", job, error: "x" })).toMatchObject({ status: "failed" });
  });
});

describe("arquivos temporários", () => {
  it("workspace do job é removido ao concluir e os arquivos ficam no Storage", async () => {
    const { readdir } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { jobId, token, campaignId } = await plannedProject("prod_t1");
    await h.call("POST", `/v1/jobs/${jobId}/generate`, { body: { token } });
    const worker = h.worker("worker-t");
    await h.drain(worker);
    const root = (worker as unknown as { options: { tmpRoot: string } }).options.tmpRoot;
    expect((await readdir(root).catch(() => [])).filter((n) => n === jobId)).toEqual([]);
    const uploads = (await h.db.query<{ n: number }>("select count(*)::int as n from product_assets where owner_id = 'prod_t1' and status = 'ready'", [])).rows[0]?.n;
    expect(uploads).toBe(1);
    void campaignId; void join;
  });

  it("publish sobe só arquivos novos (sem sobrescrever) e hydrate reconstrói o job em outro workspace", async () => {
    const { mkdir, mkdtemp, readFile, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { AssetSync } = await import("./asset-sync");
    const { AssetRepository } = await import("../repos/asset-repository");
    const { dataDirs } = await import("../runtime");
    const { campaignId } = await plannedProject("prod_t2");
    const store = new PostgresPipelineStore(h.db, TEST_USER);
    const sync = new AssetSync(h.infra.storage, new AssetRepository(h.db, TEST_USER), dataDirs(h.infra.config), TEST_USER);
    const ws1 = await mkdtemp(join(tmpdir(), "ws1-"));
    const clip = `outputs/videos/${campaignId}/scene_1/v1/clip.mp4`;
    await mkdir(join(ws1, `outputs/videos/${campaignId}/scene_1/v1`), { recursive: true });
    await writeFile(join(ws1, clip), "fake-mp4");
    await writeFile(join(ws1, `outputs/videos/${campaignId}/scene_1/v1/clip.partial.mp4`), "parcial");
    expect(await sync.publish(ws1, campaignId)).toEqual([clip]);
    expect(await sync.publish(ws1, campaignId)).toEqual([]); // idempotente
    const row = (await h.db.query<{ path: string; kind: string }>("select path, kind from generated_assets where campaign_id = $1", [campaignId])).rows[0];
    expect(row).toEqual({ path: `users/${TEST_USER}/projects/${campaignId}/clips/scene_1/v1/clip.mp4`, kind: "clip" });
    const ws2 = await mkdtemp(join(tmpdir(), "ws2-"));
    const campaign = await store.getCampaign(campaignId);
    expect(await sync.hydrate(ws2, campaign, await store.listJobs(campaignId))).toBeGreaterThanOrEqual(2); // foto + clipe
    expect(await readFile(join(ws2, clip), "utf8")).toBe("fake-mp4");
    expect(await readFile(join(ws2, campaign.request.product.images[0]!.uri))).toEqual(Buffer.from(PNG_BYTES));
  });
});
