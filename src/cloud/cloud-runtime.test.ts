import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PNG_BYTES } from "@/test/app-fixtures";
import { cloudHarness, FAKE_SECRETS, type CloudHarness } from "@/test/cloud-harness";
import { TEST_USER } from "@/test/pglite";
import { PostgresPipelineStore } from "@/cloud/repos/pipeline-repository";
import { apiUserRuntime } from "@/cloud/runtime";

/**
 * Fluxo cloud ponta a ponta, só com mocks (nenhuma API paga):
 * upload direto → criar projeto (fila) → worker → aprovar → worker → resultado,
 * com o "navegador" saindo no meio e a API reiniciando.
 */

let h: CloudHarness;
beforeAll(async () => { h = await cloudHarness(); });
afterAll(async () => { await h.close(); });

async function uploadPhoto(ownerId: string): Promise<string> {
  const auth = await h.call("POST", "/v1/uploads/authorize", { body: { ownerId, contentType: "image/png", size: PNG_BYTES.length } });
  expect(auth.status).toBe(201);
  // Upload DIRETO ao storage com a URL assinada (não passa pela API autenticada nem pelo Vercel).
  const put = await fetch(auth.json.value.uploadUrl, { method: "PUT", headers: { "Content-Type": "image/png" }, body: PNG_BYTES });
  expect(put.status).toBe(200);
  const done = await h.call("POST", "/v1/uploads/complete", { body: { ownerId, imageId: auth.json.value.imageId } });
  expect(done.status).toBe(201);
  return done.json.value.id as string;
}

const createInput = (productId: string, imageId: string) => ({ productId, name: "Secador de cabelo Pro", imageIds: [imageId], idea: "Uma mulher apresentando este secador de forma natural em um quarto.", duration: 30 });

async function failedSceneProject(ownerId: string) {
  const imageId = await uploadPhoto(ownerId);
  const created = await h.call("POST", "/v1/projects", { body: createInput(ownerId, imageId) });
  await h.drain();
  let project = await h.call("GET", `/v1/projects/${created.json.value.campaignId as string}`);
  const jobId = project.json.value.v2.jobId as string;
  expect((await h.call("POST", `/v1/jobs/${jobId}/generate`, { body: { token: project.json.value.v2.quoteToken } })).status).toBe(202);
  await h.drain();
  project = await h.call("GET", `/v1/projects/${created.json.value.campaignId as string}`);
  const approval = project.json.value.v2.approval;
  expect((await h.call("POST", `/v1/jobs/${jobId}/references/${approval.referenceId}/approve`, { body: { fidelityConfirmed: true, confirmedSpecs: approval.specs } })).status).toBe(202);
  // O teste prepara uma falha terminal sem executar a tarefa MOCK seguinte.
  await h.db.query("update job_queue set status = 'completed' where job_id = $1 and status = 'queued'", [jobId]);
  const store = new PostgresPipelineStore(h.db, TEST_USER);
  const job = await store.getJob(jobId);
  const scene = job.scenes.find(item => item.requiresGeneratedVideo)!;
  await store.saveJob({
    ...job,
    status: "failed",
    error: "Falha simulada sem rede.",
    scenes: job.scenes.map(item => item.sceneId === scene.sceneId ? {
      ...item,
      attempts: [{ id: "failed_cloud_attempt", kind: "video", sceneId: item.sceneId, attemptNumber: 1, provider: "mock", model: "mock-video", providerJobId: null, status: "failed", active: false, isMock: true, error: "Falha simulada.", createdAt: job.updatedAt }],
    } : item),
  });
  const quote = await (await apiUserRuntime(h.infra, TEST_USER)).deps.service.quoteFailedSceneRetry(jobId, scene.sceneId);
  const failedView = await h.call("GET", `/v1/projects/${job.campaignId}`);
  expect(failedView.json.value.v2.error).toMatchObject({ retry: "scene", sceneId: scene.sceneId, sceneToken: quote.token, sceneEstimatedBrl: quote.estimatedBrl });
  return { campaignId: job.campaignId, jobId, sceneId: scene.sceneId, token: quote.token };
}

describe("API pública", () => {
  it("/health simples e /ready checa banco + storage + config, sem API paga", async () => {
    const health = await h.call("GET", "/health", { user: null });
    expect(health).toMatchObject({ status: 200, text: "ok" });
    const ready = await h.call("GET", "/ready", { user: null });
    expect(ready.status).toBe(200);
    expect(ready.json.checks).toEqual({ database: true, storage: true, config: true });
  });

  it("sem sessão = 401; origem fora da lista = 403; CORS só para a origem configurada", async () => {
    expect((await h.call("GET", "/v1/projects", { user: null })).status).toBe(401);
    expect((await h.call("GET", "/v1/projects", { headers: { Origin: "https://evil.example" } })).status).toBe(403);
    const ok = await h.call("OPTIONS", "/v1/projects", { user: null, headers: { Origin: "https://app.vercel.app" } });
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://app.vercel.app");
    expect(ok.headers.get("access-control-allow-origin")).not.toBe("*");
  });
});

describe("fluxo de geração na nuvem", () => {
  it("retry individual idempotente deriva recipe no servidor e preserva ownership", async () => {
    const ctx = await failedSceneProject("prod_retry_scene");
    expect(ctx.token).toHaveLength(64);
    const before = Number((await h.db.query<{ n: number }>("select count(*)::int as n from job_queue where job_id = $1", [ctx.jobId])).rows[0]?.n);

    const first = await h.call("POST", `/v1/jobs/${ctx.jobId}/scenes/${ctx.sceneId}/retry`, { body: { token: ctx.token, stage: "avatar" } });
    const replay = await h.call("POST", `/v1/jobs/${ctx.jobId}/scenes/${ctx.sceneId}/retry`, { body: { token: ctx.token } });
    expect(first.status).toBe(202);
    expect(replay.status).toBe(202);
    expect(Number((await h.db.query<{ n: number }>("select count(*)::int as n from job_queue where job_id = $1", [ctx.jobId])).rows[0]?.n)).toBe(before + 1);

    expect((await h.call("POST", `/v1/jobs/${ctx.jobId}/scenes/${ctx.sceneId}/retry`, { user: "b", body: { token: ctx.token } })).status).toBe(404);
    expect((await h.call("POST", `/v1/jobs/${ctx.jobId}/scenes/wrong_scene/retry`, { body: { token: ctx.token } })).status).not.toBe(202);
    expect((await h.call("POST", `/v1/jobs/${ctx.jobId}/scenes/${ctx.sceneId}/retry`, { body: { token: "0".repeat(64) } })).status).not.toBe(202);
    await h.drain();
  });

  it("cria → enfileira → worker planeja → aprovar → worker gera; navegador fecha e API reinicia sem perder nada", async () => {
    const imageId = await uploadPhoto("prod_cloud1");
    // Clique duplo: mesma Idempotency-Key → mesma resposta, UM projeto.
    const headers = { "Idempotency-Key": "create-0001-abcdef" };
    const first = await h.call("POST", "/v1/projects", { body: createInput("prod_cloud1", imageId), headers });
    const second = await h.call("POST", "/v1/projects", { body: createInput("prod_cloud1", imageId), headers });
    expect(first.status).toBe(202);
    expect(second.json).toEqual(first.json);
    const campaignId = first.json.value.campaignId as string;
    expect((await h.db.query<{ n: number }>("select count(*)::int as n from campaigns where id = $1", [campaignId])).rows[0]?.n).toBe(1);
    expect((await h.call("POST", "/v1/projects", { body: { ...createInput("prod_cloud1", imageId), name: "Outro" }, headers })).status).toBe(422);

    // A API só persistiu e enfileirou: nada rodou ainda.
    expect((await h.db.query<{ status: string; kind: string }>("select status, kind from job_queue where campaign_id = $1", [campaignId])).rows).toEqual([{ status: "queued", kind: "planning" }]);
    let project = await h.call("GET", `/v1/projects/${campaignId}`);
    expect(project.json.value.v2.phase).toBe("planning");

    await h.drain();
    project = await h.call("GET", `/v1/projects/${campaignId}`);
    const v2 = project.json.value.v2;
    expect(v2.phase).toBe("ready_to_generate");
    const jobId = v2.jobId as string;

    // "Gerar vídeo": 202 imediato; clique repetido não duplica a tarefa.
    const gen = await h.call("POST", `/v1/jobs/${jobId}/generate`, { body: { token: v2.quoteToken } });
    expect(gen.status).toBe(202);
    const again = await h.call("POST", `/v1/jobs/${jobId}/generate`, { body: { token: v2.quoteToken } });
    expect(again.status).not.toBe(202);
    expect((await h.db.query<{ n: number }>("select count(*)::int as n from job_queue where job_id = $1", [jobId])).rows[0]?.n).toBe(1);
    expect((await h.call("GET", `/v1/jobs/${jobId}`)).json.value.task.status).toBe("queued");

    // Navegador fecha: ninguém consulta. O worker continua sozinho.
    await h.drain();
    // API reinicia (deploy): o estado vem do banco.
    await h.restartApi();
    const status = await h.call("GET", `/v1/jobs/${jobId}`);
    expect(status.json.value.progress).toBe("awaiting_reference_approval");
    expect(status.json.value.task.status).toBe("awaiting_approval");

    project = await h.call("GET", `/v1/projects/${campaignId}`);
    const approval = project.json.value.v2.approval;
    expect(approval).toBeTruthy();
    const approve = await h.call("POST", `/v1/jobs/${jobId}/references/${approval.referenceId}/approve`, { body: { fidelityConfirmed: true, confirmedSpecs: approval.specs } });
    expect(approve.status).toBe(202);
    await h.drain();

    const final = await h.call("GET", `/v1/jobs/${jobId}`);
    expect(final.json.value).toMatchObject({ status: "completed", progress: "completed" });
    project = await h.call("GET", `/v1/projects/${campaignId}`);
    expect(["done", "simulated_done"]).toContain(project.json.value.v2.phase);
    const events = (await h.db.query<{ stage: string }>("select stage from job_events where job_id = $1 order by id", [jobId])).rows.map((e) => e.stage);
    expect(events).toContain("awaiting_reference_approval");
    expect(events.at(-1)).toBe("completed");
  });

  it("ownership: outro usuário não vê nem mexe no projeto/job/arquivo", async () => {
    const imageId = await uploadPhoto("prod_cloud2");
    const created = await h.call("POST", "/v1/projects", { body: createInput("prod_cloud2", imageId) });
    const campaignId = created.json.value.campaignId as string;
    expect((await h.call("GET", `/v1/projects/${campaignId}`, { user: "b" })).status).toBe(404);
    expect((await h.call("POST", `/v1/projects/${campaignId}/retry-planning`, { user: "b" })).status).toBe(404);
    expect((await h.call("GET", `/v1/assets/signed?kind=upload&ownerId=prod_cloud2&imageId=${imageId}`, { user: "b" })).status).toBe(404);
    const mine = await h.call("GET", `/v1/assets/signed?kind=upload&ownerId=prod_cloud2&imageId=${imageId}`);
    expect(mine.status).toBe(200);
    expect(mine.json.value.url).toMatch(/sig=/);
    // URL assinada não é persistida em lugar nenhum: só bucket/path.
    const stored = (await h.db.query<{ n: number }>("select count(*)::int as n from product_assets where path like '%sig=%' or local_uri like '%sig=%'", [])).rows[0]?.n;
    expect(stored).toBe(0);
    expect((await h.call("GET", "/v1/projects", { user: "b" })).json.value).toEqual([]);
  });

  it("nenhuma resposta ou log expõe service role, chaves de provider ou detalhes internos", async () => {
    const responses = await Promise.all([
      h.call("GET", "/v1/bootstrap"), h.call("GET", "/v1/settings"), h.call("GET", "/ready", { user: null }),
      h.call("GET", "/v1/projects/nao_existe"), h.call("POST", "/v1/jobs/x/generate", { body: { token: "x" } }),
    ]);
    const all = responses.map((r) => r.text).join("\n") + h.logs.join("\n");
    for (const secret of Object.values(FAKE_SECRETS)) expect(all).not.toContain(secret);
    expect(all).not.toMatch(/at Object\.|stack|SELECT |postgres:\/\//i);
    expect(responses[3]!.status).toBe(404);
    expect(h.logs.some((l) => l.includes("\"requestId\""))).toBe(true);
    void TEST_USER;
  });
});

describe("proteção básica", () => {
  it("rate limit de escrita por usuário (429) sem afetar leitura", async () => {
    const limited = await cloudHarness({ writesPerMinute: 2 });
    try {
      const statuses = [];
      for (let i = 0; i < 3; i++) statuses.push((await limited.call("POST", "/v1/projects/x/retry-planning")).status);
      expect(statuses[2]).toBe(429);
      expect((await limited.call("GET", "/v1/projects")).status).toBe(200);
    } finally {
      await limited.close();
    }
  });
});
