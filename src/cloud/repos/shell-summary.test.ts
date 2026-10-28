import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projectFactsOf } from "@/application/project-facts";
import { stepUx, type UxSnapshot } from "@/application/ux-events";
import type { GenerationJob } from "@/domain/pipeline";
import { paidOperationInFlight } from "@/pipeline/paid-operation";
import { PNG_BYTES } from "@/test/app-fixtures";
import { cloudHarness, FAKE_SECRETS, type CloudHarness } from "@/test/cloud-harness";
import { TEST_USER } from "@/test/pglite";
import { PAID_IN_FLIGHT_PATHS, PostgresPipelineStore } from "./pipeline-repository";

/** L8.8.1 — leitura leve do shell no cloud: 1 consulta, sem documentos, janela priorizada, paridade SQL × TS. */

let h: CloudHarness;
beforeAll(async () => { h = await cloudHarness(); });
afterAll(async () => { await h.close(); });

async function plannedProject(ownerId: string): Promise<{ campaignId: string; jobId: string }> {
  const auth = await h.call("POST", "/v1/uploads/authorize", { body: { ownerId, contentType: "image/png", size: PNG_BYTES.length } });
  await fetch(auth.json.value.uploadUrl, { method: "PUT", headers: { "Content-Type": "image/png" }, body: PNG_BYTES });
  const done = await h.call("POST", "/v1/uploads/complete", { body: { ownerId, imageId: auth.json.value.imageId } });
  const created = await h.call("POST", "/v1/projects", { body: { productId: ownerId, name: "Projeto antigo ativo", imageIds: [done.json.value.id], idea: "Apresentação natural do produto.", duration: 30 } });
  await h.drain();
  const campaignId = created.json.value.campaignId as string;
  return { campaignId, jobId: (await h.call("GET", `/v1/projects/${campaignId}`)).json.value.v2.jobId };
}

const snapshotOfShell = (value: { projects: { id: string; name: string; status: never; durationLabel: string | null; episode: string }[] }): UxSnapshot =>
  ({ worker: null, credits: null, projects: value.projects.map((p) => ({ id: p.id, name: p.name, status: p.status, durationLabel: p.durationLabel, episode: p.episode })) });

describe("fatos leves do projeto (SQL)", () => {
  it("paridade com os documentos: mesmos fatos que projectFactsOf", async () => {
    const { campaignId } = await plannedProject("prod_facts1");
    const store = new PostgresPipelineStore(h.db, TEST_USER);
    const campaign = await store.getCampaign(campaignId);
    const job = (await store.listJobs(campaignId))[0]!;
    const withRender: GenerationJob = { ...job, renders: [{ id: "render_exec_1", renderId: "v1", status: "completed", renderer: "remotion", isMock: false, startedAt: "2026-10-23T10:00:00.000Z", finishedAt: "2026-10-23T10:01:00.000Z", durationSeconds: 31.2, warnings: [] }] };
    await store.saveJob(withRender);
    const sql = (await store.listProjectFacts()).find((f) => f.id === campaignId)!;
    const ts = projectFactsOf(campaign, withRender);
    const norm = (f: typeof ts) => ({ ...f, createdAt: new Date(f.createdAt).toISOString(), updatedAt: new Date(f.updatedAt).toISOString() });
    expect(norm(sql)).toEqual(norm(ts));
    expect(sql.job!.lastRender).toEqual({ id: "render_exec_1", isMock: false, durationSeconds: 31.2 });
  });

  it("operação paga incerta e última tentativa falha: jsonpath = regra TypeScript", async () => {
    const docs: Partial<GenerationJob>[] = [
      {}, { stageIntents: [{ state: "running" }] } as never, { stageIntents: [{ state: "done" }] } as never,
      { ugc: { references: [{ state: "pending" }] } } as never, { ugc: { references: [{ state: "pending", isMock: true }] } } as never,
      { ugc: { references: [{ state: "uncertain", isMock: false }] } } as never, { ugcVideoOperations: [{ state: "settled" }, { state: "submitted" }] } as never,
      { presenterTasks: [{ state: "submitting" }] } as never, { videoTasks: [{ state: "done" }] } as never,
    ];
    for (const doc of docs) {
      const sql = PAID_IN_FLIGHT_PATHS.map((p) => `jsonb_path_exists($1::jsonb, ${p})`).join(" or ");
      const r = await h.db.query<{ paid: boolean }>(`select (${sql}) as paid`, [JSON.stringify(doc)]);
      expect({ doc, paid: r.rows[0]!.paid }).toEqual({ doc, paid: !!paidOperationInFlight(doc as GenerationJob) });
    }
    const failed = await h.db.query<{ f: boolean }>(`select jsonb_path_exists($1::jsonb, '$.scenes[*] ? (@.attempts[last].status == "failed")') as f`, [JSON.stringify({ scenes: [{ attempts: [{ status: "failed" }, { status: "succeeded" }] }, { attempts: [{ status: "succeeded" }, { status: "failed" }] }] })]);
    expect(failed.rows[0]!.f).toBe(true);
    const recovered = await h.db.query<{ f: boolean }>(`select jsonb_path_exists($1::jsonb, '$.scenes[*] ? (@.attempts[last].status == "failed")') as f`, [JSON.stringify({ scenes: [{ attempts: [{ status: "failed" }, { status: "succeeded" }] }] })]);
    expect(recovered.rows[0]!.f).toBe(false);
  });

  it("100+ projetos: UMA consulta, payload limitado, projeto antigo ATIVO observado até concluir", async () => {
    const { campaignId: oldId, jobId: oldJob } = await plannedProject("prod_old_active");
    const store = new PostgresPipelineStore(h.db, TEST_USER);
    const template = await store.getCampaign(oldId);
    const base = Date.now() + 60_000;
    // 105 projetos MAIS NOVOS e já finalizados; o mais antigo continua aguardando ação.
    for (let i = 0; i < 105; i++) {
      const at = new Date(base + i * 1000).toISOString();
      await store.saveCampaign({ ...template, id: `campaign_bulk_${String(i).padStart(3, "0")}`, status: "failed", jobIds: [], createdAt: at, updatedAt: at, request: { ...template.request, projectName: `Bulk ${i}` } });
    }

    // Uma única consulta, qualquer que seja o número de projetos.
    let queries = 0;
    const original = h.db.query.bind(h.db);
    h.db.query = (async (...args: Parameters<typeof original>) => { queries++; return original(...args); }) as typeof h.db.query;
    try {
      const facts = await store.listProjectFacts();
      expect(facts.length).toBeGreaterThan(100);
    } finally {
      h.db.query = original;
    }
    expect(queries).toBe(1);

    const first = await h.call("GET", "/v1/shell");
    expect(first.status).toBe(200);
    const projects = first.json.value.projects as { id: string; status: string }[];
    expect(projects.length).toBeLessThanOrEqual(70);
    expect(projects.some((p) => p.id === oldId)).toBe(true); // o mais antigo, aguardando ação, continua na janela
    expect(first.text.length).toBeLessThan(30_000);
    expect(first.text).not.toMatch(/"document"|"scenes"|"prompt"|"renders"/);
    for (const secret of Object.values(FAKE_SECRETS)) expect(first.text).not.toContain(secret);

    // O antigo conclui: a transição é observada e vira UM evento com a versão do render.
    const job = await store.getJob(oldJob);
    await store.saveJob({ ...job, status: "completed", updatedAt: new Date(base + 200_000).toISOString(), renders: [{ id: "render_old_1", renderId: "v1", status: "completed", renderer: "remotion", isMock: false, startedAt: new Date().toISOString(), durationSeconds: 30, warnings: [] }] });
    const second = await h.call("GET", "/v1/shell");
    const memory = stepUx(null, snapshotOfShell(first.json.value)).memory;
    const { events } = stepUx(memory, snapshotOfShell(second.json.value));
    expect(events.map((e) => e.key)).toEqual([`project:${oldId}:completed:render-render_old_1`]);
  });

  it("/v1/shell exige sessão e é isolado por usuário", async () => {
    expect((await h.call("GET", "/v1/shell", { user: null })).status).toBe(401);
    const other = await h.call("GET", "/v1/shell", { user: "b" });
    expect(other.status).toBe(200);
    expect(other.text).not.toMatch(/campaign_bulk_|Projeto antigo ativo/);
  });
});
