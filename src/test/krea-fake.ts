import { makeMp4 } from "./mp4-fixture";
import { PNG_1X1 } from "./google-fake";

export const FAKE_KREA_KEY = "krea-fake-secret-test-key-456";
export const KREA_IMAGE_JOB = "job_image_0001";
export const KREA_VIDEO_JOB = "job_video_0001";
const ASSET_URL = "https://gen.krea.ai/assets/asset_1.png";
const IMAGE_URL = "https://gen.krea.ai/images/out_1.png";
const VIDEO_URL = "https://gen.krea.ai/videos/out_1.mp4";

export interface KreaFakeOptions {
  /** Criação do job pago. */
  create?: "ok" | "rejected" | "network" | "no_job_id";
  /** Quantas consultas devolvem `processing` antes de concluir; Infinity = nunca conclui. */
  runningPolls?: number;
  outcome?: "completed" | "failed" | "no_urls";
  /** Formato de `result.urls` (a OpenAPI aceita lista de strings ou de objetos). */
  urlShape?: "strings" | "objects";
  resultUrl?: string;
  image?: Uint8Array;
  clip?: Uint8Array;
}

/** Krea API falsa (fetch injetável): registra método, URL, headers e corpo para provar contrato e sanitização. */
export function kreaFake(options: KreaFakeOptions = {}) {
  const calls: { method: string; url: string; headers: Record<string, string>; body?: Record<string, unknown>; multipart?: boolean }[] = [];
  let polls = 0;
  let requested = 8;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push({ method, url, headers, ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as Record<string, unknown> } : {}), multipart: init?.body instanceof FormData });
    if (url.endsWith("/assets") && method === "POST") return Response.json({ id: "asset_1", image_url: ASSET_URL });
    if (url.includes("/generate/") && method === "POST") {
      const mode = options.create ?? "ok";
      if (mode === "network") throw new TypeError(`fetch failed ${FAKE_KREA_KEY}`);
      if (mode === "rejected") return Response.json({ error: { code: "invalid_prompt", message: `bad request Bearer ${FAKE_KREA_KEY}` } }, { status: 400, headers: { "x-request-id": "req_krea" } });
      if (mode === "no_job_id") return Response.json({ status: "queued" });
      if (url.includes("/video/") && typeof init?.body === "string") requested = Number((JSON.parse(init.body) as { duration?: number }).duration ?? 8);
      return Response.json({ job_id: url.includes("/video/") ? KREA_VIDEO_JOB : KREA_IMAGE_JOB, status: "queued", created_at: "2026-10-16T00:00:00Z" });
    }
    const job = /\/jobs\/([\w-]+)$/.exec(url);
    if (job && method === "GET") {
      const jobId = job[1]!;
      if (polls++ < (options.runningPolls ?? 0)) return Response.json({ job_id: jobId, status: "processing", progress: 0.5 });
      if (options.outcome === "failed") return Response.json({ job_id: jobId, status: "failed", error: { code: "nsfw", message: `blocked ${FAKE_KREA_KEY}` } });
      const out = options.resultUrl ?? (jobId === KREA_VIDEO_JOB ? VIDEO_URL : IMAGE_URL);
      const urls = options.outcome === "no_urls" ? [] : options.urlShape === "objects" ? [{ type: "output", url: out }] : [out];
      return Response.json({ job_id: jobId, status: "completed", result: { urls } });
    }
    if (url === IMAGE_URL) return new Response(new Uint8Array(options.image ?? PNG_1X1));
    if (url === VIDEO_URL) return new Response(new Uint8Array(options.clip ?? makeMp4(requested, { audioTrack: true })));
    return new Response("not found", { status: 404 });
  };
  const posts = (kind?: "image" | "video") => calls.filter(c => c.method === "POST" && c.url.includes(kind ? `/generate/${kind}/` : "/generate/")).length;
  return { fetch, calls, posts };
}
