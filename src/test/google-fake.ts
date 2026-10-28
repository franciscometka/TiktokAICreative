import { makeMp4 } from "./mp4-fixture";

/** PNG 1x1 válido (assinatura + IHDR) para entradas/saídas falsas. */
export const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
export const FAKE_GOOGLE_KEY = "AIza-fake-secret-test-key-123";
export const VEO_OPERATION = "models/veo-3.1-fast-generate-preview/operations/op_1";
const VIDEO_URI = "https://generativelanguage.googleapis.com/v1beta/files/vid_1:download?alt=media";

export interface GoogleFakeOptions {
  /** Resposta do generateContent (imagem). */
  image?: "ok" | "rejected" | "server_error" | "network" | "no_image" | "invalid_image";
  /** Criação Veo. */
  veoSubmit?: "ok" | "rejected" | "network" | "no_name";
  /** Quantas consultas devolvem done=false antes de concluir; Infinity = nunca conclui. */
  veoRunningPolls?: number;
  veoOutcome?: "ok" | "error" | "filtered";
  clip?: Uint8Array;
  /** Download via redirect para outro host (sem chave). */
  redirect?: string;
}

/** Gemini API falsa (fetch injetável): conta POST/GET e registra headers para provar sanitização. */
export function googleFake(options: GoogleFakeOptions = {}) {
  const calls: { method: string; url: string; headers: Record<string, string>; body?: Record<string, unknown> }[] = [];
  let polls = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push({ method, url, headers, ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as Record<string, unknown> } : {}) });
    if (url.includes(":generateContent")) {
      const mode = options.image ?? "ok";
      if (mode === "network") throw new TypeError(`fetch failed ${FAKE_GOOGLE_KEY}`);
      if (mode === "rejected") return Response.json({ error: { code: 400, status: "INVALID_ARGUMENT", message: `bad request key=${FAKE_GOOGLE_KEY}` } }, { status: 400, headers: { "x-request-id": "req_img" } });
      if (mode === "server_error") return Response.json({ error: { code: 500, status: "INTERNAL" } }, { status: 500 });
      if (mode === "no_image") return Response.json({ responseId: "resp_1", candidates: [{ finishReason: "IMAGE_SAFETY", content: { parts: [] } }] });
      const data = mode === "invalid_image" ? Buffer.from("not-an-image").toString("base64") : PNG_1X1.toString("base64");
      return Response.json({ responseId: "resp_1", modelVersion: "gemini-3.1-flash-image", usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 1290 },
        candidates: [{ finishReason: "STOP", content: { parts: [{ inlineData: { mimeType: "image/png", data } }] } }] }, { headers: { "x-request-id": "req_img" } });
    }
    if (url.includes(":predictLongRunning")) {
      const mode = options.veoSubmit ?? "ok";
      if (mode === "network") throw Object.assign(new Error("socket hang up"), { name: "TimeoutError" });
      if (mode === "rejected") return Response.json({ error: { code: 403, status: "PERMISSION_DENIED", message: "denied" } }, { status: 403 });
      return Response.json(mode === "no_name" ? {} : { name: VEO_OPERATION }, { headers: { "x-request-id": "req_veo" } });
    }
    if (url.includes("/operations/")) {
      polls++;
      if (polls <= (options.veoRunningPolls ?? 0)) return Response.json({ name: VEO_OPERATION, done: false });
      if (options.veoOutcome === "error") return Response.json({ name: VEO_OPERATION, done: true, error: { code: 13, status: "INTERNAL", message: "generation failed" } });
      if (options.veoOutcome === "filtered") return Response.json({ name: VEO_OPERATION, done: true, response: { generateVideoResponse: { raiMediaFilteredCount: 1 } } });
      return Response.json({ name: VEO_OPERATION, done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: VIDEO_URI } }] } } });
    }
    if (url === VIDEO_URI) {
      if (options.redirect) return new Response(null, { status: 302, headers: { location: options.redirect } });
      return new Response(Buffer.from(options.clip ?? makeMp4(8, { audioTrack: true })));
    }
    if (options.redirect && url === options.redirect) return new Response(Buffer.from(options.clip ?? makeMp4(8, { audioTrack: true })));
    throw new Error(`URL inesperada no fake Google: ${url}`);
  };
  const count = (method: string) => calls.filter(call => call.method === method).length;
  return { fetch, calls, posts: () => count("POST"), gets: () => count("GET") };
}
