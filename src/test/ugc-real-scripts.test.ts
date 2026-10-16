import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { FAKE_GOOGLE_KEY, PNG_1X1 } from "./google-fake";
import { makeMp4 } from "./mp4-fixture";

/** Hook carregado no processo do script: substitui fetch e registra cada chamada num arquivo. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ugc-cli-"));
  const image = join(root, "produto.png");
  await writeFile(image, PNG_1X1);
  const clip = join(root, "clip.mp4");
  await writeFile(clip, makeMp4(8, { audioTrack: true }));
  const log = join(root, "network.log");
  const hook = join(root, "google-hook.mjs");
  await writeFile(hook, `import { appendFileSync, readFileSync } from 'node:fs';
const png = ${JSON.stringify(PNG_1X1.toString("base64"))};
globalThis.fetch = async (input, init = {}) => {
  const url = String(input); const method = init.method ?? 'GET';
  appendFileSync(process.env.NETWORK_LOG, method + ' ' + url + '\\n');
  if (url.includes(':generateContent')) return Response.json({ responseId: 'resp_cli', candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: png } }] } }] }, { headers: { 'x-request-id': 'req_cli' } });
  if (url.includes(':predictLongRunning')) return Response.json({ name: 'models/veo-3.1-fast-generate-preview/operations/op_cli' });
  if (url.includes('/operations/')) return Response.json({ done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://generativelanguage.googleapis.com/v1beta/files/v:download?alt=media' } }] } } });
  if (url.includes(':download')) return new Response(readFileSync(process.env.CLIP_FILE));
  throw new Error('URL inesperada');
};`);
  const dirs = { DATA_DIR: rel(join(root, "data")), UPLOADS_DIR: rel(join(root, "uploads")), UGC_DIR: rel(join(root, "ugc")), VIDEOS_DIR: rel(join(root, "videos")) };
  const run = (script: string, args: string[], env: Record<string, string> = {}) => {
    try {
      const stdout = execFileSync(process.execPath, ["--import", pathToFileURL(hook).href, "--import", "tsx", `scripts/${script}.ts`, ...args], {
        encoding: "utf8", stdio: "pipe", timeout: 60_000,
        env: { ...process.env, GOOGLE_AI_API_KEY: "", UGC_PROVIDER: "", UGC_REAL_ALLOWED: "", ...dirs, NETWORK_LOG: log, CLIP_FILE: clip, ...env },
      });
      return { ok: true, out: stdout };
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string };
      return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  };
  const network = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);
  return { root, image, run, network, dirs };
}
const rel = (path: string) => relative(process.cwd(), path);
const READY = { GOOGLE_AI_API_KEY: FAKE_GOOGLE_KEY, UGC_PROVIDER: "google", UGC_REAL_ALLOWED: "true" };

describe("scripts AI UGC REAL", () => {
  it("dry-run (sem --confirm): nenhuma rede, nenhuma gravação; mostra modelo, formato, custo e readiness", async () => {
    const f = await fixture();
    const reference = f.run("ugc-reference-real", ["--image", f.image]);
    expect(reference.ok).toBe(true);
    expect(reference.out).toMatch(/gemini-3\.1-flash-image · 9:16 · 1K/);
    expect(reference.out).toContain("US$0.0670");
    expect(reference.out).toContain("Readiness Google AI UGC: BLOQUEADO");
    const video = f.run("ugc-video-real", [], READY);
    expect(video.ok).toBe(true);
    expect(video.out).toMatch(/veo-3\.1-fast-generate-preview · 720p · 9:16 · 8s · áudio NATIVO/);
    expect(video.out).toContain("US$0.8000");
    expect(video.out).toContain("Readiness Google AI UGC: PRONTO");
    expect(video.out).not.toContain(FAKE_GOOGLE_KEY);
    expect(f.network()).toHaveLength(0);
    expect(existsSync(join(f.root, "data"))).toBe(false);
    expect(existsSync(join(f.root, "uploads"))).toBe(false);
  }, 90_000);

  it("--confirm sem readiness completo (chave sozinha) é recusado sem rede", async () => {
    const f = await fixture();
    const result = f.run("ugc-reference-real", ["--image", f.image, "--confirm"], { GOOGLE_AI_API_KEY: FAKE_GOOGLE_KEY });
    expect(result.ok).toBe(false);
    expect(result.out).toMatch(/AI UGC REAL indisponível/);
    expect(result.out).not.toContain(FAKE_GOOGLE_KEY);
    expect(f.network()).toHaveLength(0);
    expect(existsSync(join(f.root, "data"))).toBe(false);
  }, 60_000);

  it("flag desconhecida nunca vira confirmação", async () => {
    const f = await fixture();
    expect(f.run("ugc-reference-real", ["--image", f.image, "--confirmed"], READY).ok).toBe(false);
    expect(f.run("ugc-video-real", ["--yes"], READY).ok).toBe(false);
    expect(f.network()).toHaveLength(0);
  }, 60_000);

  it("Teste A com --confirm: EXATAMENTE um POST; Teste B exige aprovação visual e faz EXATAMENTE um POST", async () => {
    const f = await fixture();
    const a = f.run("ugc-reference-real", ["--image", f.image, "--confirm"], READY);
    expect(a.ok, a.out).toBe(true);
    expect(a.out).not.toContain(FAKE_GOOGLE_KEY);
    expect(f.network().filter(line => line.startsWith("POST"))).toEqual([expect.stringMatching(/gemini-3\.1-flash-image:generateContent$/)]);
    const id = /intenção (ugcref_\w+)/.exec(a.out)?.[1];
    expect(id).toBeTruthy();
    const intent = JSON.parse(readFileSync(join(f.root, "data", "ugc-validation", `${id}.json`), "utf8"));
    expect(intent).toMatchObject({ status: "succeeded", operationId: "gemini/resp_cli", requestId: "req_cli", actualCostUsd: 0.067 });

    const blocked = f.run("ugc-video-real", ["--reference", id!, "--confirm"], READY);
    expect(blocked.ok).toBe(false);
    expect(blocked.out).toMatch(/não aprovada visualmente/);
    expect(f.network()).toHaveLength(1);

    expect(f.run("ugc-reference-real", ["--approve", id!], READY).ok).toBe(true);
    const b = f.run("ugc-video-real", ["--reference", id!, "--confirm"], READY);
    expect(b.ok, b.out).toBe(true);
    expect(b.out).toContain("áudio nativo presente");
    const posts = f.network().filter(line => line.startsWith("POST"));
    expect(posts).toHaveLength(2);
    expect(posts[1]).toMatch(/veo-3\.1-fast-generate-preview:predictLongRunning$/);
    expect(f.network().filter(line => line.includes("/operations/"))).toHaveLength(1);
  }, 120_000);
});
