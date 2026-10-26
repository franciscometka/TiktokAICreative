import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertSafeStoragePath, LocalAssetStore, storagePathOwner } from "./assets/asset-store";
import { SupabaseAssetStore } from "./assets/supabase-asset-store";
import { classifyLocalUri, storageKeyForLocalUri, type DataDirs } from "./assets/storage-layout";
import { assertNoPublicSecrets, CloudConfigError, loadApiEnv, loadFrontendEnv, loadWorkerEnv } from "./config";
import { createLogger, redact } from "./logger";
import { cleanupStaleWorkspaces, createWorkspace, removeWorkspace, workspaceDir, workspaceKey } from "./worker/temp-workspace";
import { TEST_USER } from "@/test/pglite";

const SUPA = { PERSISTENCE_DRIVER: "supabase", DATABASE_URL: "postgresql://u:p@db.example.supabase.co:5432/postgres", SUPABASE_URL: "https://proj.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-secret-value-0123456789" };
const DIRS: DataDirs = { uploadsDir: "outputs/uploads", ugcDir: "outputs/ugc", videosDir: "outputs/videos", audioDir: "outputs/audio", rendersDir: "outputs/renders" };

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
async function tmp() { const d = await mkdtemp(join(tmpdir(), "cloud-")); dirs.push(d); return d; }

describe("config por serviço (falha no startup)", () => {
  it("API cloud sem DATABASE_URL/SUPABASE falha com os NOMES, nunca os valores", () => {
    expect(() => loadApiEnv({ PERSISTENCE_DRIVER: "supabase", SUPABASE_SERVICE_ROLE_KEY: "super-secret-value-should-not-leak" })).toThrow(CloudConfigError);
    try { loadApiEnv({ PERSISTENCE_DRIVER: "supabase", SUPABASE_SERVICE_ROLE_KEY: "super-secret-value-should-not-leak" }); } catch (error) {
      expect(String(error)).toMatch(/DATABASE_URL/);
      expect(String(error)).toMatch(/SUPABASE_URL/);
      expect(String(error)).not.toMatch(/super-secret/);
    }
  });

  it("CORS '*' é recusado; origens explícitas aceitas", () => {
    expect(() => loadApiEnv({ ...SUPA, CORS_ALLOWED_ORIGINS: "*" })).toThrow(/não é permitido/);
    expect(loadApiEnv({ ...SUPA, CORS_ALLOWED_ORIGINS: "https://app.vercel.app,http://localhost:3000" }).corsOrigins).toEqual(["https://app.vercel.app", "http://localhost:3000"]);
  });

  it("worker exige a fila do Postgres; local continua o padrão do dev", () => {
    expect(() => loadWorkerEnv({})).toThrow(/PERSISTENCE_DRIVER/);
    expect(loadWorkerEnv(SUPA).tmpRoot).toBe("/tmp/tiktok-ai");
    expect(loadApiEnv({}).persistence).toBe("local");
  });

  it("DEV_AUTH_USER_ID é proibido em produção", () => {
    expect(() => loadApiEnv({ ...SUPA, NODE_ENV: "production", DEV_AUTH_USER_ID: TEST_USER })).toThrow(/proibida em produção/);
  });

  it("frontend cloud exige só variáveis públicas e recusa segredo com NEXT_PUBLIC_", () => {
    expect(() => loadFrontendEnv({ NEXT_PUBLIC_RUNTIME_MODE: "cloud" })).toThrow(/NEXT_PUBLIC_API_BASE_URL/);
    const ok = loadFrontendEnv({ NEXT_PUBLIC_RUNTIME_MODE: "cloud", NEXT_PUBLIC_API_BASE_URL: "https://api.onrender.com/", NEXT_PUBLIC_SUPABASE_URL: "https://proj.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key-public-0123456789" });
    expect(ok.apiBaseUrl).toBe("https://api.onrender.com");
    expect(() => assertNoPublicSecrets({ NEXT_PUBLIC_KREA_API_KEY: "x" })).toThrow(/segredo/);
    expect(() => assertNoPublicSecrets({ NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY: "x" })).toThrow(/segredo/);
    expect(() => assertNoPublicSecrets({ SUPABASE_SERVICE_ROLE_KEY: "service-role-secret-value", NEXT_PUBLIC_WHATEVER: "service-role-secret-value" })).toThrow(/valor de um segredo/);
  });
});

describe("logger estruturado", () => {
  it("redige authorization, tokens, URLs assinadas e valores de segredo", () => {
    const lines: string[] = [];
    const log = createLogger({ service: "api", sink: (l) => lines.push(l), secrets: ["krea-secret-123456789"] }).child({ requestId: "r1", jobId: "job_1" });
    log.error("falhou krea-secret-123456789", { headers: { authorization: "Bearer abc.def.ghi" }, url: "https://x.supabase.co/storage/v1/object/sign/b/p.mp4?token=eyJhbGci", apiKey: "k", stage: "ugc_video" });
    const entry = JSON.parse(lines[0]!);
    expect(entry).toMatchObject({ level: "error", service: "api", requestId: "r1", jobId: "job_1", stage: "ugc_video", apiKey: "[redacted]" });
    expect(lines[0]).not.toMatch(/krea-secret|abc\.def|eyJhbGci/);
    expect(entry.url).toBe("https://x.supabase.co/storage/v1/object/sign/b/p.mp4?[redacted]");
    expect(redact({ nested: { password: "p", ok: 1 } })).toEqual({ nested: { password: "[redacted]", ok: 1 } });
  });
});

describe("AssetStore", () => {
  it("chave de storage: só users/{uuid}/..., sem traversal", () => {
    expect(assertSafeStoragePath(`users/${TEST_USER}/uploads/prod_1/img_a.png`)).toBeTruthy();
    expect(storagePathOwner(`users/${TEST_USER}/projects/c/renders/v1/final.mp4`)).toBe(TEST_USER);
    for (const bad of ["uploads/x.png", `users/${TEST_USER}/../x`, `/users/${TEST_USER}/a`, `users/not-a-uuid/a`, `users/${TEST_USER}/a//b`]) expect(() => assertSafeStoragePath(bad)).toThrow();
  });

  it("LocalAssetStore: put/get/exists/delete e URL assinada com validade", async () => {
    let now = 1_000_000_000_000;
    const store = new LocalAssetStore(await tmp(), "tiktok-media", { secret: "local-signing-secret-xyz", baseUrl: "http://localhost:4000", now: () => now });
    const path = `users/${TEST_USER}/projects/c1/renders/c1/v1/final.mp4`;
    await store.put(path, new Uint8Array([1, 2, 3]), { contentType: "video/mp4" });
    expect(await store.exists(path)).toBe(true);
    expect([...(await store.get(path))!]).toEqual([1, 2, 3]);
    await expect(store.put(path, new Uint8Array([9]), { contentType: "video/mp4" })).rejects.toThrow(); // nunca sobrescreve sem upsert
    const url = new URL(await store.getSignedUrl(path, { expiresInSeconds: 60 }));
    expect(store.verify(path, url.searchParams.get("exp"), url.searchParams.get("sig"), "read")).toBe(true);
    expect(store.verify(path, url.searchParams.get("exp"), url.searchParams.get("sig"), "write")).toBe(false);
    now += 61_000;
    expect(store.verify(path, url.searchParams.get("exp"), url.searchParams.get("sig"), "read")).toBe(false);
    expect(await store.delete(path)).toBe(true);
    expect(await store.exists(path)).toBe(false);
  });

  it("SupabaseAssetStore: REST com service role só no header; URL assinada sob demanda", async () => {
    const calls: { method: string; url: string; auth: string | null; body?: unknown }[] = [];
    const fake: typeof fetch = async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({ method: init?.method ?? "GET", url, auth: headers.get("authorization"), body: init?.body });
      if (url.includes("/object/sign/")) return Response.json({ signedURL: "/object/sign/tiktok-media/users/x/final.mp4?token=abc" });
      if (url.includes("/object/upload/sign/")) return Response.json({ url: "/object/upload/sign/tiktok-media/users/x/img.png?token=up" });
      if (init?.method === "HEAD") return new Response(null, { status: url.endsWith("missing.png") ? 400 : 200 });
      if (init?.method === "DELETE") return Response.json([{ name: "x" }]);
      if (init?.method === "GET" && url.includes("/bucket/")) return Response.json({ id: "tiktok-media" });
      if (init?.method === "GET") return new Response(new Uint8Array([7, 7]));
      return Response.json({ Key: "ok" });
    };
    const store = new SupabaseAssetStore({ url: "https://proj.supabase.co", serviceRoleKey: "service-role-secret-value-0123456789", bucket: "tiktok-media", fetch: fake });
    const path = `users/${TEST_USER}/projects/c1/renders/c1/v1/final.mp4`;
    await store.put(path, new Uint8Array([1]), { contentType: "video/mp4" });
    expect(calls[0]).toMatchObject({ method: "POST", url: `https://proj.supabase.co/storage/v1/object/tiktok-media/${path}`, auth: "Bearer service-role-secret-value-0123456789" });
    const signed = await store.getSignedUrl(path, { expiresInSeconds: 600, downloadName: "video.mp4" });
    expect(signed).toBe("https://proj.supabase.co/storage/v1/object/sign/tiktok-media/users/x/final.mp4?token=abc&download=video.mp4");
    expect(JSON.parse(String(calls[1]!.body))).toEqual({ expiresIn: 600 });
    expect((await store.createSignedUpload(`users/${TEST_USER}/uploads/p/img.png`)).url).toMatch(/\/storage\/v1\/object\/upload\/sign\/.+token=up$/);
    expect(await store.exists(`users/${TEST_USER}/uploads/p/missing.png`)).toBe(false);
    expect([...(await store.get(path))!]).toEqual([7, 7]);
    expect(await store.delete(path)).toBe(true);
    expect(await store.ping()).toBe(true);
    await expect(store.put("../etc/passwd", new Uint8Array([1]), { contentType: "x" })).rejects.toThrow();
  });

  it("layout: URI local relativa ↔ chave users/{userId}/projects/{campaignId}/...", () => {
    expect(storageKeyForLocalUri(TEST_USER, "outputs/renders/camp_1/cre_1/v2/final.mp4", DIRS)).toMatchObject({ key: `users/${TEST_USER}/projects/camp_1/renders/cre_1/v2/final.mp4`, kind: "render", ownerId: "camp_1" });
    expect(storageKeyForLocalUri(TEST_USER, "outputs/uploads/prod_1/img_a.png", DIRS).key).toBe(`users/${TEST_USER}/uploads/prod_1/img_a.png`);
    expect(storageKeyForLocalUri(TEST_USER, "outputs/videos/camp_1/scene_1/v1/clip.mp4", DIRS).key).toBe(`users/${TEST_USER}/projects/camp_1/clips/scene_1/v1/clip.mp4`);
    expect(classifyLocalUri("../outputs/renders/x/y", DIRS)).toBeUndefined();
    expect(classifyLocalUri("C:/outputs/renders/x/y", DIRS)).toBeUndefined();
    expect(classifyLocalUri("data/campaigns/x.json", DIRS)).toBeUndefined();
  });
});

describe("workspace temporário por job", () => {
  it("cria /{root}/{jobId}, recusa id inseguro e limpa só o abandonado", async () => {
    const root = await tmp();
    const active = await createWorkspace(root, "job_active");
    await createWorkspace(root, "job_old");
    await writeFile(join(root, "job_old", "scene.mp4"), "x");
    const old = new Date(Date.now() - 48 * 3600_000);
    await utimes(join(root, "job_old"), old, old);
    await mkdir(join(root, "job_kept"));
    await utimes(join(root, "job_kept"), old, old);
    expect(() => workspaceDir(root, "../escape")).toThrow();
    const removed = await cleanupStaleWorkspaces(root, { maxAgeMs: 12 * 3600_000, keep: new Set(["job_kept"]) });
    expect(removed).toEqual(["job_old"]);
    await removeWorkspace(root, "job_active");
    expect(active).toContain("job_active");
  });

  it("workspace por worker: mesmo job em dois workers = pastas diferentes; limpeza por idade continua", async () => {
    const root = await tmp();
    const a = workspaceKey("job_shared", "render-host.internal-1a2b3c4d");
    const b = workspaceKey("job_shared", "render-host.internal-9f8e7d6c");
    expect(a).not.toBe(b);
    expect(a).toBe(workspaceKey("job_shared", "render-host.internal-1a2b3c4d"));
    expect(a.startsWith("job_shared-")).toBe(true);
    const dirA = await createWorkspace(root, a);
    const dirB = await createWorkspace(root, b);
    expect(dirA).not.toBe(dirB);
    // O workerId (hostname com ponto) nunca vira nome inseguro, e a limpeza encontra o diretório antigo.
    expect(() => workspaceDir(root, a)).not.toThrow();
    const old = new Date(Date.now() - 48 * 3600_000);
    await utimes(dirA, old, old);
    expect(await cleanupStaleWorkspaces(root, { maxAgeMs: 12 * 3600_000 })).toEqual([a]);
    await removeWorkspace(root, b);
  });
});
