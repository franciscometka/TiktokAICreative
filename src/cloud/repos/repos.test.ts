import { generateKeyPairSync, createHmac, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QUALITY_PRESETS } from "@/config/quality-presets";
import type { GenerationCost } from "@/domain/cost";
import type { Campaign, GenerationJob } from "@/domain/pipeline";
import { NotFoundError } from "@/storage/pipeline-store";
import { campaignRequest, createHarness } from "@/test/fixtures";
import { JPEG_BYTES, PNG_BYTES } from "@/test/app-fixtures";
import { migratedTestDb, OTHER_USER, TEST_USER, type PgliteSqlClient } from "@/test/pglite";
import { LocalAssetStore } from "../assets/asset-store";
import { CloudUploadStore } from "../assets/cloud-upload-store";
import { verifySupabaseJwt, type JwksProvider } from "../auth/jwt";
import { AssetRepository } from "./asset-repository";
import { PostgresAvatarLibraryStore } from "./avatar-repository";
import { PostgresCostLedger, PostgresLlmCallLog } from "./ledger-repository";
import { PostgresPipelineStore } from "./pipeline-repository";
import { paidOperationInFlight, progressStageOf } from "./progress";

let db: PgliteSqlClient;
let tmp: string;
beforeAll(async () => { db = await migratedTestDb(); tmp = await mkdtemp(join(tmpdir(), "cloud-repos-")); });
afterAll(async () => { await db.close(); await rm(tmp, { recursive: true, force: true }); });

const DIRS = { uploadsDir: "outputs/uploads", ugcDir: "outputs/ugc", videosDir: "outputs/videos", audioDir: "outputs/audio", rendersDir: "outputs/renders" };
const campaign = (id: string, over: Partial<Campaign> = {}): Campaign => ({ id, status: "draft", request: campaignRequest(), settings: QUALITY_PRESETS.economy, jobIds: [], createdAt: "2026-10-21T10:00:00.000Z", updatedAt: "2026-10-21T10:00:00.000Z", ...over });
const job = (id: string, campaignId: string, over: Partial<GenerationJob> = {}): GenerationJob => ({ id, campaignId, creativeId: "creative_1", status: "planned", scenes: [], audioAttempts: [], renders: [], createdAt: "2026-10-21T10:00:00.000Z", updatedAt: "2026-10-21T10:00:00.000Z", ...over });
const cost = (id: string, campaignId: string, jobId: string | null = null): GenerationCost => ({ kind: "actual", id, campaignId, jobId, creativeId: null, sceneId: null, attemptId: null, llmCallId: null, operation: "campaign_plan", category: "llm", description: "t", provider: "anthropic", model: "m", unit: "per_1m_output_tokens", quantity: 1, unitPriceUsd: 1, costUsd: 0.01, exchangeRate: 5, costBrl: 0.05, simulated: false, createdAt: "2026-10-21T10:00:00.000Z" });

describe("PostgresPipelineStore (repository cloud)", () => {
  it("round-trip validado, jobs na ordem de campaign.jobIds, listagem por usuário", async () => {
    const store = new PostgresPipelineStore(db, TEST_USER);
    await store.saveCampaign(campaign("camp_rt"));
    await store.saveJob(job("job_rt_b", "camp_rt"));
    await store.saveJob(job("job_rt_a", "camp_rt"));
    await store.saveCampaign(campaign("camp_rt", { status: "planned", jobIds: ["job_rt_a", "job_rt_b"] }));
    expect((await store.getCampaign("camp_rt")).status).toBe("planned");
    expect((await store.listJobs("camp_rt")).map((j) => j.id)).toEqual(["job_rt_a", "job_rt_b"]);
    expect(await store.listCampaignIds()).toContain("camp_rt");
    const project = (await db.query<{ title: string; status: string }>("select title, status from projects where id = 'camp_rt'", [])).rows[0];
    expect(project).toMatchObject({ status: "planned" });
  });

  it("ownership: outro usuário não lê, não sobrescreve e não pendura job na campanha alheia", async () => {
    const mine = new PostgresPipelineStore(db, TEST_USER);
    const theirs = new PostgresPipelineStore(db, OTHER_USER);
    await mine.saveCampaign(campaign("camp_own"));
    await mine.saveJob(job("job_own", "camp_own"));
    await expect(theirs.getCampaign("camp_own")).rejects.toBeInstanceOf(NotFoundError);
    await expect(theirs.getJob("job_own")).rejects.toBeInstanceOf(NotFoundError);
    await expect(theirs.saveCampaign(campaign("camp_own", { status: "failed" }))).rejects.toThrow(/não encontrada/);
    await expect(theirs.saveJob(job("job_x", "camp_own"))).rejects.toThrow(/não encontrado/);
    await expect(theirs.saveJob(job("job_own", "camp_own", { status: "cancelled" }))).rejects.toThrow();
    expect((await mine.getJob("job_own")).status).toBe("planned");
    expect(await theirs.listCampaignIds()).not.toContain("camp_own");
  });

  it("progresso persistido + evento a cada mudança; projeções de referência/render/tentativa paga", async () => {
    const store = new PostgresPipelineStore(db, TEST_USER);
    await store.saveCampaign(campaign("camp_pg"));
    await store.saveJob(job("job_pg", "camp_pg", { status: "generating", currentStage: "ugc_reference", stageIntents: [{ stage: "ugc_reference", unit: "1 imagem", state: "running", createdAt: "2026-10-21T10:01:00.000Z" }] }));
    let row = (await db.query<{ progress_stage: string }>("select progress_stage from jobs where id = 'job_pg'", [])).rows[0];
    expect(row?.progress_stage).toBe("reference");
    const attempts = (await db.query<{ stage: string; status: string }>("select stage, status from job_attempts where job_id = 'job_pg'", [])).rows;
    expect(attempts).toEqual([{ stage: "ugc_reference", status: "started" }]);
    await store.saveJob(job("job_pg", "camp_pg", { status: "completed", renders: [{ id: "render_1", renderId: "v1", status: "completed", renderer: "remotion", isMock: false, startedAt: "t", outputUri: "outputs/renders/camp_pg/creative_1/v1/final.mp4", warnings: [] }], stageIntents: [{ stage: "ugc_reference", unit: "1 imagem", state: "settled", createdAt: "2026-10-21T10:01:00.000Z" }] }));
    row = (await db.query<{ progress_stage: string }>("select progress_stage from jobs where id = 'job_pg'", [])).rows[0];
    expect(row?.progress_stage).toBe("completed");
    expect((await db.query<{ status: string }>("select status from job_attempts where job_id = 'job_pg'", [])).rows).toEqual([{ status: "confirmed" }]);
    expect((await db.query<{ render_id: string }>("select render_id from render_jobs where job_id = 'job_pg'", [])).rows).toEqual([{ render_id: "v1" }]);
    const events = (await db.query<{ stage: string }>("select stage from job_events where job_id = 'job_pg' order by id", [])).rows.map((e) => e.stage);
    expect(events).toEqual(["reference", "completed"]);
  });

  it("pipeline completo (mocks) roda sobre Postgres sem mudar regra de negócio", async () => {
    const userId = "33333333-3333-4333-8333-333333333333";
    const h = createHarness({ storage: { store: new PostgresPipelineStore(db, userId), ledger: new PostgresCostLedger(db, userId), llmCallLog: new PostgresLlmCallLog(db, userId) } });
    const planned = await h.service.planCampaign(campaignRequest());
    expect(planned.status).toBe("planned");
    const [first] = await h.service.listJobs(planned.id);
    expect(first?.estimate).toBeDefined();
    const approval = await h.service.requestApproval(first!.id);
    await h.service.approve(first!.id, { estimateId: approval.estimate.id });
    const outcome = await h.service.generate(first!.id);
    expect(outcome.kind).toBe("COMPLETED");
    expect((await h.ledger.list({ campaignId: planned.id })).length).toBeGreaterThan(0);
  });
});

describe("ledger e chamadas de LLM", () => {
  it("append-only, filtro por campanha/job, isolado por usuário, duplicado recusado", async () => {
    await new PostgresPipelineStore(db, TEST_USER).saveCampaign(campaign("camp_led"));
    const ledger = new PostgresCostLedger(db, TEST_USER);
    await ledger.record(cost("ledcost_1", "camp_led"));
    await ledger.record(cost("ledcost_2", "camp_led", "job_z"));
    await expect(ledger.record(cost("ledcost_1", "camp_led"))).rejects.toThrow(/duplicado/);
    expect((await ledger.list({ campaignId: "camp_led" })).map((e) => e.id)).toEqual(["ledcost_1", "ledcost_2"]);
    expect((await ledger.list({ campaignId: "camp_led", jobId: null })).map((e) => e.id)).toEqual(["ledcost_1"]);
    expect(await new PostgresCostLedger(db, OTHER_USER).list({ campaignId: "camp_led" })).toEqual([]);
    const row = (await db.query<{ stage: string; currency: string; status: string; confirmed_cost_brl: string }>("select stage, currency, status, confirmed_cost_brl from ledger_entries where id = 'ledcost_1'", [])).rows[0];
    expect(row).toMatchObject({ stage: "llm", currency: "BRL", status: "confirmed" });
  });
});

describe("avatares", () => {
  it("revisões congeladas e escopo por usuário", async () => {
    const store = new PostgresAvatarLibraryStore(db, TEST_USER);
    const base = { id: "avatar_marina", revision: 1, name: "Marina", gender: "woman", tags: ["beleza"], defaultForTags: [], personality: "", defaultEnvironment: "", hair: "", visualAgeRange: "30s", defaultOutfit: "", appearanceDescriptors: "", appearancePrompt: "", speakingStyle: "", preferredProductCategories: [], active: true, archived: false, createdAt: "2026-10-21T10:00:00.000Z", updatedAt: "2026-10-21T10:00:00.000Z" };
    const r1 = { ...base } as never;
    await store.saveAvatarRecord({ current: r1, revisions: [r1] });
    const r2 = { ...base, revision: 2, name: "Marina B", updatedAt: "2026-10-21T11:00:00.000Z" } as never;
    // Tentativa de reescrever a revisão 1 é ignorada: a revisão usada por jobs antigos não muda.
    await store.saveAvatarRecord({ current: r2, revisions: [{ ...base, name: "ADULTERADA" } as never, r2] });
    expect((await store.getAvatarRevision("avatar_marina", 1)).name).toBe("Marina");
    expect((await store.getAvatarRecord("avatar_marina")).current.name).toBe("Marina B");
    expect(await new PostgresAvatarLibraryStore(db, OTHER_USER).listAvatars()).toEqual([]);
    await expect(new PostgresAvatarLibraryStore(db, OTHER_USER).saveAvatarRecord({ current: r2, revisions: [r2] })).rejects.toThrow(/não encontrado/);
  });
});

describe("upload seguro (direto ao storage)", () => {
  function uploads(userId = TEST_USER) {
    const storage = new LocalAssetStore(tmp, "tiktok-media", { secret: "local-signing-secret-xyz", baseUrl: "http://localhost:4000" });
    return { storage, store: new CloudUploadStore(new AssetRepository(db, userId), storage, DIRS, userId) };
  }

  it("authorize → arquivo no storage → complete confere bytes reais; URI local compatível", async () => {
    const { storage, store } = uploads();
    const { imageId, upload } = await store.authorize("prod_up1", { declaredType: "image/png", size: PNG_BYTES.length });
    expect(upload.url).toContain("/v1/local-assets/users/");
    expect(await store.list("prod_up1")).toEqual([]); // pending não conta como pronto
    await storage.put(upload.path, PNG_BYTES, { contentType: "image/png" });
    const ready = await store.complete("prod_up1", imageId);
    expect(ready.uri).toBe(`outputs/uploads/prod_up1/${imageId}`);
    expect((await store.resolve("prod_up1", [imageId])).map((i) => i.id)).toEqual([imageId]);
    expect(await uploads(OTHER_USER).store.resolve("prod_up1", [imageId])).toEqual([]);
  });

  it("conteúdo que não bate com o tipo declarado é rejeitado e apagado", async () => {
    const { storage, store } = uploads();
    const { imageId, upload } = await store.authorize("prod_up2", { declaredType: "image/png", size: 100 });
    await storage.put(upload.path, JPEG_BYTES, { contentType: "image/png" });
    await expect(store.complete("prod_up2", imageId)).rejects.toThrow();
    expect(await storage.exists(upload.path)).toBe(false);
    await expect(store.authorize("prod_up2", { declaredType: "image/gif", size: 10 })).rejects.toThrow();
    await expect(store.authorize("prod_up2", { declaredType: "image/png", size: 50 * 1024 * 1024 })).rejects.toThrow();
  });
});

describe("auth: JWT do Supabase", () => {
  const SUPABASE_URL = "https://proj.supabase.co";
  const now = () => 1_800_000_000_000;
  const claims = (over: Record<string, unknown> = {}) => ({ sub: TEST_USER, role: "authenticated", aud: "authenticated", iss: `${SUPABASE_URL}/auth/v1`, exp: 1_800_000_600, ...over });
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const hs = (payload: unknown, secret = "legacy-jwt-secret-with-32-characters!!") => {
    const head = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}`;
    return `${head}.${createHmac("sha256", secret).update(head).digest("base64url")}`;
  };

  it("HS256 legado: válido → userId do sub; expirado/emissor errado/assinatura errada → recusado", async () => {
    const opts = { supabaseUrl: SUPABASE_URL, jwtSecret: "legacy-jwt-secret-with-32-characters!!", now };
    expect(await verifySupabaseJwt(hs(claims()), opts)).toEqual({ userId: TEST_USER });
    await expect(verifySupabaseJwt(hs(claims({ exp: 1_700_000_000 })), opts)).rejects.toThrow(/expirada/);
    await expect(verifySupabaseJwt(hs(claims({ iss: "https://evil/auth/v1" })), opts)).rejects.toThrow();
    await expect(verifySupabaseJwt(hs(claims(), "other-secret-other-secret-other-secret"), opts)).rejects.toThrow();
    await expect(verifySupabaseJwt(hs(claims({ role: "anon" })), opts)).rejects.toThrow();
    await expect(verifySupabaseJwt(`${b64({ alg: "none" })}.${b64(claims())}.`, opts)).rejects.toThrow();
  });

  it("ES256 via JWKS (chaves assimétricas do Supabase)", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwks: JwksProvider = { getKey: async (kid) => (kid === "k1" ? publicKey : undefined) };
    const head = `${b64({ alg: "ES256", kid: "k1", typ: "JWT" })}.${b64(claims())}`;
    const token = `${head}.${sign("sha256", Buffer.from(head), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
    expect((await verifySupabaseJwt(token, { supabaseUrl: SUPABASE_URL, jwks, now })).userId).toBe(TEST_USER);
    const forged = `${b64({ alg: "ES256", kid: "k1", typ: "JWT" })}.${b64(claims({ sub: OTHER_USER }))}.${token.split(".")[2]}`;
    await expect(verifySupabaseJwt(forged, { supabaseUrl: SUPABASE_URL, jwks, now })).rejects.toThrow();
  });
});

describe("retomada: operação paga em voo", () => {
  it("detecta intenção running, referência incerta e operação Veo não liquidada", () => {
    expect(paidOperationInFlight(job("j", "c"))).toBeUndefined();
    expect(paidOperationInFlight(job("j", "c", { stageIntents: [{ stage: "ugc_video", unit: "1 trecho", state: "running", createdAt: "t" }] }))).toMatch(/ugc_video/);
    expect(progressStageOf(job("j", "c", { status: "generating", waitingForStage: "ugc_reference" }))).toBe("awaiting_reference_approval");
  });
});
