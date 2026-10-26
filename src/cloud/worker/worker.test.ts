import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GenerationJob } from "@/domain/pipeline";
import { assertExecutionFence } from "@/config/execution-policy";
import { PNG_BYTES } from "@/test/app-fixtures";
import { cloudHarness, type CloudHarness } from "@/test/cloud-harness";
import { TEST_USER } from "@/test/pglite";
import { PostgresPipelineStore } from "../repos/pipeline-repository";
import { workerUserRuntime } from "../runtime";
import { PostgresCostLedger } from "../repos/ledger-repository";
import { CloudWorker, finishForOutcome } from "./worker";
import { QueueDispatcher } from "../queue/job-queue";

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
    expect(await h.infra.queue.finish(claimed[0]!.id, owner === "w1" ? "w2" : "w1", claimed[0]!.attempts, { status: "completed", outcome: "x" })).toBe(false); // só o dono encerra
    expect(await h.infra.queue.finish(claimed[0]!.id, owner, claimed[0]!.attempts, { status: "completed", outcome: "x" })).toBe(true);
    const next = await h.infra.queue.claim("w3", 30);
    expect(next?.dedupeKey).toBe(claimed[0]!.dedupeKey === "test:race:1" ? "test:race:2" : "test:race:1");
    await h.infra.queue.finish(next!.id, "w3", next!.attempts, { status: "completed", outcome: "x" });
  });

  it("callback do claim N não renova nem encerra o claim N+1 do MESMO worker", async () => {
    const { campaignId } = await plannedProject("prod_q_generation");
    const base = { userId: TEST_USER, campaignId, jobId: null, payload: { kind: "planning" as const, planningRunId: "x", realAuthorized: false }, paid: false };
    const queued = await h.infra.queue.enqueue({ ...base, dedupeKey: "test:generation" });
    const n = (await h.infra.queue.claim("worker-same", 30))!;
    expect(n.id).toBe(queued.task.id);
    // Lease de N expira; a tarefa volta à fila e o MESMO workerId faz o claim N+1.
    await h.db.query("update job_queue set lease_expires_at = now() - interval '1 second' where id = $1", [n.id]);
    expect(await h.infra.queue.recover(n.id, { action: "requeue" })).toBe(true);
    const next = (await h.infra.queue.claim("worker-same", 30))!;
    expect(next).toMatchObject({ id: n.id, attempts: n.attempts + 1 });

    expect(await h.infra.queue.heartbeat(n.id, "worker-same", n.attempts, 30)).toBe(false);
    expect(await h.infra.queue.finish(n.id, "worker-same", n.attempts, { status: "failed", outcome: "stale" })).toBe(false);
    expect(await h.infra.queue.get(n.id)).toMatchObject({ status: "running", attempts: next.attempts, outcome: null });

    expect(await h.infra.queue.heartbeat(n.id, "worker-same", next.attempts, 30)).toBe(true);
    expect(await h.infra.queue.finish(n.id, "worker-same", next.attempts, { status: "completed", outcome: "x" })).toBe(true);
  });

  it("dedupe do job aceita replay da mesma intent e recusa engolir outra operação", async () => {
    const { campaignId, jobId } = await plannedProject("prod_q_retry");
    const store = new PostgresPipelineStore(h.db, TEST_USER);
    const job = await store.getJob(jobId);
    const dispatcher = new QueueDispatcher(h.infra.queue, TEST_USER);
    const retry2 = { kind: "scene_retry" as const, retryIntentId: "retry_scene_2" };
    await dispatcher.enqueueJob(job, retry2);
    await expect(dispatcher.enqueueJob(job, retry2)).resolves.toBeUndefined();
    await expect(dispatcher.enqueueJob(job, { kind: "scene_retry", retryIntentId: "retry_scene_4" })).rejects.toThrow(/outra operação/i);
    await expect(dispatcher.enqueueJob(job, { kind: "authorized" })).rejects.toThrow(/outra operação/i);
    expect((await h.db.query<{ n: number }>("select count(*)::int as n from job_queue where campaign_id = $1 and status = 'queued'", [campaignId])).rows[0]?.n).toBe(1);
    await h.db.query("update job_queue set status = 'completed' where campaign_id = $1", [campaignId]);
    await expect(dispatcher.enqueueJob(job, { kind: "scene_retry", retryIntentId: "retry_scene_4" })).resolves.toBeUndefined();
    expect((await h.db.query<{ n: number }>("select count(*)::int as n from job_queue where campaign_id = $1 and kind = 'job_run'", [campaignId])).rows[0]?.n).toBe(2);
    await h.db.query("update job_queue set status = 'completed' where campaign_id = $1", [campaignId]);
  });
});

describe("restart do worker", () => {
  it("worker vivo que perdeu o lease não submete nem grava depois do novo claim", async () => {
    const { campaignId, jobId } = await plannedProject("prod_fenced_retry");
    const store = new PostgresPipelineStore(h.db, TEST_USER);
    const original = await store.getJob(jobId);
    const sceneId = original.scenes.find(scene => scene.requiresGeneratedVideo)!.sceneId;
    const queued = await h.infra.queue.enqueue({
      userId: TEST_USER,
      campaignId,
      jobId,
      payload: { kind: "job_run", run: { kind: "scene_retry", retryIntentId: "scene_retry_fenced" } },
      paid: true,
      dedupeKey: `job:${jobId}`,
    });
    let releaseA!: () => void;
    let enteredA!: () => void;
    const blockedA = new Promise<void>(resolve => { releaseA = resolve; });
    const aEntered = new Promise<void>(resolve => { enteredA = resolve; });
    let providerSubmits = 0;
    const tmp = await mkdtemp(join(tmpdir(), "worker-fence-"));
    // A acredita que continua dono: o heartbeat "funciona" mas não renova nada no banco (processo travado/partição).
    // Só o checkpoint() SQL pode descobrir que o claim mudou.
    const heartbeat = h.infra.queue.heartbeat.bind(h.infra.queue);
    h.infra.queue.heartbeat = async (...args: Parameters<typeof heartbeat>) => args[1] === "worker-fence-a" ? true : heartbeat(...args);
    const checkpoint = h.infra.queue.checkpoint.bind(h.infra.queue);
    const checkpointsOfA: boolean[] = [];
    h.infra.queue.checkpoint = async (...args: Parameters<typeof checkpoint>) => {
      const owned = await checkpoint(...args);
      if (args[1] === "worker-fence-a") checkpointsOfA.push(owned);
      return owned;
    };

    const runtimeFor = (blockBeforeProvider: boolean) => (infra: typeof h.infra, userId: string, roots: { projectRoot: string; assetRoot: string }) => {
      const runtime = workerUserRuntime(infra, userId, roots);
      runtime.deps.service.runJobTask = async (id) => {
        if (blockBeforeProvider) { enteredA(); await blockedA; }
        await assertExecutionFence();
        providerSubmits++;
        const current = await runtime.store.getJob(id);
        const attemptId = `fenced_attempt_${providerSubmits}`;
        const next = {
          ...current,
          scenes: current.scenes.map(scene => scene.sceneId === sceneId ? {
            ...scene,
            attempts: [...scene.attempts, { id: attemptId, kind: "video" as const, sceneId, attemptNumber: scene.attempts.length + 1, provider: "fake-paid", model: "fake-v1", providerJobId: `op_${providerSubmits}`, status: "succeeded" as const, active: true, isMock: false, assetUri: `fake://${attemptId}`, durationSeconds: 4, createdAt: new Date().toISOString() }],
          } : scene),
        };
        await assertExecutionFence();
        await runtime.store.saveJob(next);
        await new PostgresCostLedger(h.db, TEST_USER).record({ kind: "actual", id: `cost_${attemptId}`, campaignId, jobId, creativeId: current.creativeId, sceneId, attemptId, llmCallId: null, operation: "video_generation", category: "video", description: "fenced provider submit", provider: "fake-paid", model: "fake-v1", unit: "per_generation", quantity: 1, unitPriceUsd: 1, costUsd: 1, exchangeRate: 5, costBrl: 5, simulated: false, createdAt: new Date().toISOString() });
        return { kind: "WAITING_STAGE" as const, job: next };
      };
      return runtime;
    };
    const workerA = new CloudWorker({ infra: h.infra, workerId: "worker-fence-a", tmpRoot: join(tmp, "a"), projectRoot: process.cwd(), leaseSeconds: 1, pollIntervalMs: 10, chdir: false, runtimeFor: runtimeFor(true) });
    const workerB = new CloudWorker({ infra: h.infra, workerId: "worker-fence-b", tmpRoot: join(tmp, "b"), projectRoot: process.cwd(), leaseSeconds: 1, pollIntervalMs: 10, chdir: false, runtimeFor: runtimeFor(false) });

    try {
      const oldRun = workerA.tick();
      await aEntered;
      await sleep(1_300);
      expect(await workerB.recoverExpired()).toBe(1);
      expect((await h.infra.queue.get(queued.task.id))?.status).toBe("queued");
      expect(await workerB.tick()).toBe("processed");
      const afterB = await store.getJob(jobId);
      const taskAfterB = await h.infra.queue.get(queued.task.id);
      releaseA();
      expect(await oldRun).toBe("processed");

      // Quem detectou a perda foi o SQL do checkpoint (o heartbeat de A nunca reportou perda).
      expect(checkpointsOfA).toEqual([false]);
      expect(providerSubmits).toBe(1);
      expect((await store.getJob(jobId)).scenes.find(scene => scene.sceneId === sceneId)!.attempts).toHaveLength(1);
      expect((await new PostgresCostLedger(h.db, TEST_USER).list({ jobId })).filter(entry => !entry.simulated)).toHaveLength(1);
      // Nenhuma escrita de A depois da perda: job e tarefa ficam exatamente como B deixou.
      expect(await store.getJob(jobId)).toEqual(afterB);
      expect(await h.infra.queue.get(queued.task.id)).toEqual(taskAfterB);
    } finally {
      releaseA();
      h.infra.queue.heartbeat = heartbeat;
      h.infra.queue.checkpoint = checkpoint;
      await rm(tmp, { recursive: true, force: true });
    }
  });

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
    expect(await h.infra.queue.heartbeat(task!.id, "dead-worker", task!.attempts, 30)).toBe(false);
    expect(await h.infra.queue.finish(task!.id, "dead-worker", task!.attempts, { status: "completed", outcome: "late" })).toBe(false);
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

describe("L8.6 — fila × gerando (só leitura)", () => {
  it("aprovado e sem worker = \"Na fila\"; assumido pelo claim = \"Gerando\"; nada é executado aqui", async () => {
    const { campaignId, jobId, token } = await plannedProject("prod_q86");
    expect((await h.call("POST", `/v1/jobs/${jobId}/generate`, { body: { token } })).status).toBe(202);
    const queued = (await h.call("GET", `/v1/projects/${campaignId}`)).json.value;
    expect(queued.view.creatives[0].queued).toBe(true);
    expect((await h.call("GET", "/v1/projects")).json.value.find((c: { id: string }) => c.id === campaignId)).toMatchObject({ status: "queued", statusLabel: "Na fila" });
    expect((await h.infra.queue.activeStates(TEST_USER)).get(`job:${jobId}`)).toBe("queued");
    // Simula SÓ o claim (o worker assumiu); a tarefa não roda neste teste.
    const task = await h.infra.queue.claim("w86", 30);
    expect(task?.jobId).toBe(jobId);
    const running = (await h.call("GET", `/v1/projects/${campaignId}`)).json.value;
    expect(running.view.creatives[0].queued).toBe(false);
    expect((await h.call("GET", "/v1/projects")).json.value.find((c: { id: string }) => c.id === campaignId)).toMatchObject({ status: "generating", statusLabel: "Gerando" });
    await h.infra.queue.finish(task!.id, "w86", task!.attempts, { status: "completed", outcome: "test" });
  });
});
