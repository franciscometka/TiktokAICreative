import { createHmac, createPublicKey, timingSafeEqual, verify, type KeyObject } from "node:crypto";

/**
 * Validação da sessão do Supabase Auth na API (D102). O userId SEMPRE vem do `sub` de um JWT
 * com assinatura, emissor, audiência e validade conferidos — nunca do corpo/headers do request.
 *
 * Suporta as chaves assimétricas do Supabase (ES256/RS256 via JWKS em
 * `{SUPABASE_URL}/auth/v1/.well-known/jwks.json`) e o segredo legado HS256. `alg: none` e
 * algoritmos fora da lista são recusados.
 */

export class AuthError extends Error {
  override name = "AuthError";
}

export interface AuthUser {
  userId: string;
  email?: string;
}

export interface JwksProvider {
  getKey(kid: string): Promise<KeyObject | undefined>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const b64 = (s: string) => Buffer.from(s, "base64url");

/** JWKS com cache (10 min) e refresh quando aparece um `kid` desconhecido (rotação de chave). */
export class RemoteJwks implements JwksProvider {
  private cache: { at: number; keys: Map<string, KeyObject> } | undefined;

  constructor(private readonly url: string, private readonly fetcher: typeof fetch = fetch, private readonly ttlMs = 600_000) {}

  async getKey(kid: string): Promise<KeyObject | undefined> {
    const fresh = this.cache && Date.now() - this.cache.at < this.ttlMs;
    if (!fresh || !this.cache!.keys.has(kid)) await this.refresh();
    return this.cache?.keys.get(kid);
  }

  private async refresh(): Promise<void> {
    const response = await this.fetcher(this.url, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new AuthError("Não foi possível validar a sessão agora.");
    const body = (await response.json()) as { keys?: (Record<string, unknown> & { kid?: string })[] };
    const keys = new Map<string, KeyObject>();
    for (const jwk of body.keys ?? []) if (jwk.kid) keys.set(jwk.kid, createPublicKey({ key: jwk as never, format: "jwk" }));
    this.cache = { at: Date.now(), keys };
  }
}

export interface VerifyOptions {
  supabaseUrl: string;
  jwtSecret?: string;
  jwks?: JwksProvider;
  now?: () => number;
}

export async function verifySupabaseJwt(token: string, options: VerifyOptions): Promise<AuthUser> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]*$/.test(p))) throw new AuthError("Sessão inválida.");
  const [rawHeader, rawPayload, rawSignature] = parts as [string, string, string];
  let header: { alg?: string; kid?: string; typ?: string };
  let payload: { sub?: string; exp?: number; nbf?: number; iss?: string; aud?: string | string[]; role?: string; email?: string };
  try {
    header = JSON.parse(b64(rawHeader).toString("utf8"));
    payload = JSON.parse(b64(rawPayload).toString("utf8"));
  } catch {
    throw new AuthError("Sessão inválida.");
  }
  const data = Buffer.from(`${rawHeader}.${rawPayload}`);
  const signature = b64(rawSignature);

  if (header.alg === "HS256") {
    if (!options.jwtSecret) throw new AuthError("Sessão inválida.");
    const expected = createHmac("sha256", options.jwtSecret).update(data).digest();
    if (expected.length !== signature.length || !timingSafeEqual(expected, signature)) throw new AuthError("Sessão inválida.");
  } else if (header.alg === "ES256" || header.alg === "RS256") {
    if (!options.jwks || !header.kid) throw new AuthError("Sessão inválida.");
    const key = await options.jwks.getKey(header.kid);
    if (!key) throw new AuthError("Sessão inválida.");
    const ok = header.alg === "ES256"
      ? verify("sha256", data, { key, dsaEncoding: "ieee-p1363" }, signature)
      : verify("sha256", data, key, signature);
    if (!ok) throw new AuthError("Sessão inválida.");
  } else {
    throw new AuthError("Sessão inválida.");
  }

  const now = Math.floor((options.now?.() ?? Date.now()) / 1000);
  if (typeof payload.exp !== "number" || payload.exp < now - 30) throw new AuthError("Sessão expirada.");
  if (typeof payload.nbf === "number" && payload.nbf > now + 30) throw new AuthError("Sessão inválida.");
  if (payload.iss !== `${options.supabaseUrl.replace(/\/+$/, "")}/auth/v1`) throw new AuthError("Sessão inválida.");
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes("authenticated") || payload.role !== "authenticated") throw new AuthError("Sessão inválida.");
  if (!payload.sub || !UUID.test(payload.sub)) throw new AuthError("Sessão inválida.");
  return { userId: payload.sub.toLowerCase(), ...(payload.email ? { email: payload.email } : {}) };
}

/** Extrai o bearer token do header Authorization (nunca de query string). */
export function bearerToken(header: string | null | undefined): string | undefined {
  const match = /^Bearer\s+([A-Za-z0-9._-]+)$/.exec(header?.trim() ?? "");
  return match?.[1];
}
