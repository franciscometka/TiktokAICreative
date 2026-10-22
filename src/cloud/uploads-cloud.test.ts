import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SupabaseAssetStore } from "@/cloud/assets/supabase-asset-store";
import { toUserError } from "@/application/user-errors";
import { DeployMisconfiguredError, DEPLOY_MISCONFIGURED_MESSAGE, deployMisconfiguration, parseRuntimeMode } from "@/lib/runtime-mode";
import { JPEG_BYTES, PNG_BYTES } from "@/test/app-fixtures";
import { cloudHarness, type CloudHarness } from "@/test/cloud-harness";
import { TEST_USER } from "@/test/pglite";

/*
 * Upload cloud (Lote 7): Browser → authorize (API) → PUT direto no Storage pela URL assinada →
 * complete (API confere bytes) → product_assets pending → ready. Avatar e produto usam o MESMO
 * fluxo. Tudo offline: Postgres real (PGlite) + storage local com URL assinada.
 */

const WEBP_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 26, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20, 1, 2, 3, 4]);
const FILES = [
  { type: "image/jpeg", bytes: JPEG_BYTES, ext: "jpg" },
  { type: "image/png", bytes: PNG_BYTES, ext: "png" },
  { type: "image/webp", bytes: WEBP_BYTES, ext: "webp" },
] as const;

let h: CloudHarness;
beforeAll(async () => { h = await cloudHarness(); });
afterAll(async () => { await h.close(); });

const row = async (ownerId: string, imageId: string) =>
  (await h.db.query<{ status: string; owner_kind: string; user_id: string; path: string; content_type: string }>("select status, owner_kind, user_id, path, content_type from product_assets where owner_id = $1 and id = $2", [ownerId, imageId])).rows[0];

/** Exatamente o que o `ImageUploader` faz no browser (headers incluídos). */
async function browserUpload(ownerId: string, file: { type: string; bytes: Uint8Array }, sent: Uint8Array = file.bytes) {
  const auth = await h.call("POST", "/v1/uploads/authorize", { body: { ownerId, contentType: file.type, size: sent.byteLength } });
  if (auth.status !== 201) return { auth };
  const pending = await row(ownerId, auth.json.value.imageId);
  const put = await fetch(auth.json.value.uploadUrl, { method: "PUT", headers: { "Content-Type": file.type, "x-upsert": "false" }, body: new Uint8Array(sent) });
  const done = await h.call("POST", "/v1/uploads/complete", { body: { ownerId, imageId: auth.json.value.imageId } });
  return { auth, pending, put, done, imageId: auth.json.value.imageId as string };
}

describe("upload cloud — avatar", () => {
  for (const file of FILES) {
    it(`avatar_<uuid> + ${file.ext.toUpperCase()}: authorize → PUT → complete; pending → ready; preview assinado`, async () => {
      const ownerId = `avatar_${randomUUID()}`;
      const r = await browserUpload(ownerId, file);
      expect(r.auth.status).toBe(201);
      expect(r.auth.json.value.imageId).toMatch(new RegExp(`^img_[0-9a-f-]{36}\\.${file.ext}$`));
      expect(r.pending).toMatchObject({ status: "pending", owner_kind: "avatar", user_id: TEST_USER, content_type: file.type });
      expect(r.pending!.path).toBe(`users/${TEST_USER}/uploads/${ownerId}/${r.imageId}`);
      expect(r.put!.status).toBe(200);
      expect(r.done!.status).toBe(201);
      expect(r.done!.json.value).toMatchObject({ productId: ownerId, id: r.imageId, previewUrl: `/api/uploads/${ownerId}/${r.imageId}` });
      expect((await row(ownerId, r.imageId!))!.status).toBe("ready");
      const preview = await h.call("GET", `/v1/assets/signed?kind=upload&ownerId=${ownerId}&imageId=${r.imageId}`);
      expect(preview.status).toBe(200);
      const image = await fetch(preview.json.value.url);
      expect(image.status).toBe(200);
      expect(new Uint8Array(await image.arrayBuffer())).toEqual(new Uint8Array(file.bytes));
    });
  }

  it("avatar salvo com a foto enviada: a revisão guarda a imagem pronta", async () => {
    const ownerId = `avatar_${randomUUID()}`;
    const r = await browserUpload(ownerId, FILES[1]);
    const saved = await h.call("POST", "/v1/avatars", { body: { id: ownerId, name: "Cristina", gender: "woman", referenceImage: { ownerId, imageId: r.imageId } } });
    expect(saved.status).toBeLessThan(300);
    const avatar = await h.call("GET", `/v1/avatars/${ownerId}`);
    expect(avatar.json.value.imageUrl).toBe(`/api/uploads/${ownerId}/${r.imageId}`);
  });
});

describe("upload cloud — produto (mesmo componente e fluxo)", () => {
  for (const file of FILES) {
    it(`produto + ${file.ext.toUpperCase()}: pending → ready e preview`, async () => {
      const ownerId = `prod_${randomUUID().slice(0, 8)}`;
      const r = await browserUpload(ownerId, file);
      expect(r.pending).toMatchObject({ status: "pending", owner_kind: "product" });
      expect(r.done!.status).toBe(201);
      expect((await row(ownerId, r.imageId!))!.status).toBe("ready");
      expect((await h.call("GET", `/v1/assets/signed?kind=upload&ownerId=${ownerId}&imageId=${r.imageId}`)).status).toBe(200);
    });
  }
});

describe("upload cloud — validações continuam", () => {
  it("tipo não suportado ou tamanho acima do limite: recusado no authorize, nada criado", async () => {
    const ownerId = `avatar_${randomUUID()}`;
    const gif = await h.call("POST", "/v1/uploads/authorize", { body: { ownerId, contentType: "image/gif", size: 10 } });
    expect(gif.status).toBe(422);
    expect(gif.json.error.code).toBe("upload");
    const big = await h.call("POST", "/v1/uploads/authorize", { body: { ownerId, contentType: "image/png", size: 50 * 1024 * 1024 } });
    expect(big.status).toBe(422);
    expect((await h.db.query("select 1 from product_assets where owner_id = $1", [ownerId])).rows).toHaveLength(0);
  });

  it("bytes falsos (texto declarado como PNG): complete recusa, linha rejected e objeto apagado", async () => {
    const ownerId = `avatar_${randomUUID()}`;
    const fake = new TextEncoder().encode("isto não é uma imagem png de verdade");
    const r = await browserUpload(ownerId, { type: "image/png", bytes: fake });
    expect(r.put!.status).toBe(200);
    expect(r.done!.status).toBe(422);
    expect(r.done!.json.error.code).toBe("upload");
    expect((await row(ownerId, r.imageId!))!.status).toBe("rejected");
    expect((await h.call("GET", `/v1/assets/signed?kind=upload&ownerId=${ownerId}&imageId=${r.imageId}`)).status).toBe(404);
  });

  it("JPEG declarado mas PNG enviado: recusado (tipo real precisa bater)", async () => {
    const ownerId = `prod_${randomUUID().slice(0, 8)}`;
    const r = await browserUpload(ownerId, { type: "image/jpeg", bytes: JPEG_BYTES }, PNG_BYTES);
    expect(r.done!.status).toBe(422);
  });

  it("complete sem o PUT: recusado com mensagem de upload (não \"erro inesperado\")", async () => {
    const ownerId = `avatar_${randomUUID()}`;
    const auth = await h.call("POST", "/v1/uploads/authorize", { body: { ownerId, contentType: "image/png", size: PNG_BYTES.length } });
    const done = await h.call("POST", "/v1/uploads/complete", { body: { ownerId, imageId: auth.json.value.imageId } });
    expect(done.status).toBe(422);
    expect(done.json.error.message).not.toMatch(/inesperado/);
  });

  it("ownerId fora do padrão SAFE_PRODUCT_ID e sem sessão: recusados", async () => {
    expect((await h.call("POST", "/v1/uploads/authorize", { body: { ownerId: "../x", contentType: "image/png", size: 10 } })).status).toBe(422);
    expect((await h.call("POST", "/v1/uploads/authorize", { user: null, body: { ownerId: "avatar_x", contentType: "image/png", size: 10 } })).status).toBe(401);
  });
});

describe("Supabase Storage — URL de upload assinada (formato real)", () => {
  it("URL relativa do Supabase vira absoluta em /storage/v1 com o token; sem service role na URL", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const store = new SupabaseAssetStore({
      url: "https://abc.supabase.co", serviceRoleKey: "service-role-secret-value-0123456789", bucket: "tiktok-media",
      fetch: (async (url: string, init?: RequestInit) => {
        calls.push({ url, ...(init ? { init } : {}) });
        return Response.json({ url: `/object/upload/sign/tiktok-media/users/${TEST_USER}/uploads/avatar_x/img.png?token=tok123`, token: "tok123" });
      }) as typeof fetch,
    });
    const signed = await store.createSignedUpload(`users/${TEST_USER}/uploads/avatar_x/img.png`);
    expect(calls[0]!.url).toBe(`https://abc.supabase.co/storage/v1/object/upload/sign/tiktok-media/users/${TEST_USER}/uploads/avatar_x/img.png`);
    expect(calls[0]!.init!.method).toBe("POST");
    expect(signed.url).toBe(`https://abc.supabase.co/storage/v1/object/upload/sign/tiktok-media/users/${TEST_USER}/uploads/avatar_x/img.png?token=tok123`);
    expect(signed.url).not.toContain("service-role");
  });

  it("falha do Storage vira erro de upload claro (não \"erro inesperado\")", () => {
    const error = Object.assign(new Error("Storage recusou a autorização de upload (HTTP 403)"), { name: "StorageError" });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(toUserError(error)).toMatchObject({ code: "upload", retryable: true });
    expect(toUserError(error).message).not.toMatch(/inesperado/);
    spy.mockRestore();
  });
});

describe("modo de execução do deploy (causa-raiz do erro em produção)", () => {
  it("NEXT_PUBLIC_RUNTIME_MODE normalizado: espaços, aspas e maiúsculas não derrubam o cloud", () => {
    for (const v of ["cloud", " cloud\n", "\"cloud\"", "'cloud'", "CLOUD"]) expect(parseRuntimeMode(v)).toBe("cloud");
    for (const v of [undefined, "", "local", "clouds"]) expect(parseRuntimeMode(v)).toBe("local");
  });

  it("build da Vercel em modo local (variáveis ausentes no ambiente do deploy) é detectado", () => {
    expect(deployMisconfiguration({ VERCEL: "1" }, "local")).toBe(DEPLOY_MISCONFIGURED_MESSAGE);
    expect(deployMisconfiguration({ VERCEL: "1" }, "cloud")).toBeUndefined();
    expect(deployMisconfiguration({}, "local")).toBeUndefined();
    expect(toUserError(new DeployMisconfiguredError())).toMatchObject({ code: "unavailable", title: "Deploy sem modo cloud" });
  });

  it("rota /api/uploads num build local da Vercel: responde a causa (JSON) e NÃO grava no disco", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("NEXT_PUBLIC_RUNTIME_MODE", "");
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const runtime = await import("@/server/runtime");
    const getRuntime = vi.spyOn(runtime, "getRuntime");
    const { POST } = await import("@/app/api/uploads/route");
    const body = new FormData();
    body.set("file", new File([new Uint8Array(PNG_BYTES)], "a.png", { type: "image/png" }));
    const response = await POST(new Request("http://localhost/api/uploads", { method: "POST", body }));
    expect(response.status).toBe(503);
    const json = await response.json();
    expect(json.error.title).toBe("Deploy sem modo cloud");
    expect(json.error.message).toMatch(/NEXT_PUBLIC_RUNTIME_MODE=cloud/);
    expect(getRuntime).not.toHaveBeenCalled();
    expect(() => runtime.getRuntime()).toThrow(/modo local/);
    vi.unstubAllEnvs();
    spy.mockRestore();
  });
});

describe("API: login e banco de projetos Supabase diferentes", () => {
  it("usuário da sessão ausente em auth.users do banco (FK) → erro de configuração claro, não \"inesperado\"", async () => {
    const other = await cloudHarness();
    try {
      await other.db.query("create table fake_auth_users (id uuid primary key)", []);
      await other.db.query("alter table profiles add constraint profiles_fake_fk foreign key (user_id) references fake_auth_users (id)", []);
      const r = await other.call("POST", "/v1/uploads/authorize", { body: { ownerId: "avatar_x", contentType: "image/png", size: 10 } });
      expect(r.status).toBe(500);
      expect(r.json.error.code).toBe("config");
      expect(r.json.error.message).toMatch(/projetos Supabase diferentes/);
    } finally {
      await other.close();
    }
  });
});
