import type { IncomingMessage, ServerResponse } from "node:http";

/** Helpers HTTP mínimos (node:http, sem framework). Nenhum stack trace sai daqui. */

export class HttpError extends Error {
  override name = "HttpError";
  constructor(readonly status: number, readonly code: string, message: string, readonly retryable = false) {
    super(message);
  }
}

export const MAX_JSON_BYTES = 64 * 1024;

export async function readJson(req: IncomingMessage, limit = MAX_JSON_BYTES): Promise<unknown> {
  const type = req.headers["content-type"] ?? "";
  if (req.method === "GET" || req.method === "HEAD" || req.method === "DELETE") return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, "validation", "Pedido grande demais.");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  if (!type.includes("application/json")) throw new HttpError(415, "validation", "Envie JSON.");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "validation", "JSON inválido.");
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers });
  res.end(text);
}

export function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end(text);
}

export interface Route<C> {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: (ctx: C, params: Record<string, string>) => Promise<void>;
  /** Escrita (conta no rate limit). */
  write: boolean;
  /** Rota pública (sem sessão). */
  public?: boolean;
}

/** "/v1/jobs/:id" → regex com grupos nomeados por chave. IDs só com caracteres seguros. */
export function route<C>(method: string, path: string, handler: Route<C>["handler"], options: { public?: boolean } = {}): Route<C> {
  const keys: string[] = [];
  const pattern = new RegExp(`^${path.replace(/:([a-zA-Z]+)/g, (_, key: string) => { keys.push(key); return "([A-Za-z0-9_.-]{1,160})"; })}$`);
  return { method, pattern, keys, handler, write: method !== "GET" && method !== "HEAD", ...(options.public ? { public: true } : {}) };
}

export function match<C>(routes: readonly Route<C>[], method: string, path: string): { route: Route<C>; params: Record<string, string> } | "method_not_allowed" | undefined {
  let pathMatched = false;
  for (const r of routes) {
    const m = r.pattern.exec(path);
    if (!m) continue;
    pathMatched = true;
    if (r.method !== method) continue;
    return { route: r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1]!)])) };
  }
  return pathMatched ? "method_not_allowed" : undefined;
}

/** Janela deslizante em memória por usuário (proteção básica contra spam de geração). */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly limit: number, private readonly windowMs = 60_000, private readonly now: () => number = Date.now) {}

  allow(key: string): boolean {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (recent.length >= this.limit) { this.hits.set(key, recent); return false; }
    recent.push(t);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (!v.some((x) => t - x < this.windowMs)) this.hits.delete(k);
    return true;
  }
}

export function corsHeaders(origin: string | undefined, allowed: readonly string[]): Record<string, string> | undefined {
  if (!origin || !allowed.includes(origin)) return undefined;
  return {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
    "Access-Control-Allow-Credentials": "false",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Idempotency-Key, X-Request-Id",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Max-Age": "600",
  };
}
