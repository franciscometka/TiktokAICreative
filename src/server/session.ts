import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { loadFrontendEnv } from "@/cloud/config";

/**
 * Sessão do modo cloud (Lote 7, D102): Supabase Auth via REST com a ANON key (pública).
 * Tokens ficam em cookies httpOnly (o JavaScript do browser não lê); o servidor do Next envia
 * o access token à Render API como Bearer. Nenhum segredo de provider ou service role aqui.
 */

const ACCESS = "cf_at";
const REFRESH = "cf_rt";
const EXPIRES = "cf_exp";

export function runtimeMode(): "local" | "cloud" {
  return process.env.NEXT_PUBLIC_RUNTIME_MODE === "cloud" ? "cloud" : "local";
}

/** Caminho interno seguro para redirecionar depois do login (nunca URL externa). */
export function safeNext(next: string | null | undefined): string {
  return next && /^\/[A-Za-z0-9/_?=&.%-]*$/.test(next) && !next.startsWith("//") ? next : "/";
}

interface TokenResponse { access_token?: string; refresh_token?: string; expires_in?: number }

async function authRequest(grant: "password" | "refresh_token", body: Record<string, string>): Promise<TokenResponse | undefined> {
  const env = loadFrontendEnv();
  if (!env.supabaseUrl || !env.supabaseAnonKey) return undefined;
  try {
    const response = await fetch(`${env.supabaseUrl}/auth/v1/token?grant_type=${grant}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: env.supabaseAnonKey },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return undefined;
    return (await response.json()) as TokenResponse;
  } catch {
    return undefined;
  }
}

async function store(tokens: TokenResponse): Promise<boolean> {
  if (!tokens.access_token || !tokens.refresh_token) return false;
  const jar = await cookies();
  const options = { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax" as const, path: "/" };
  jar.set(ACCESS, tokens.access_token, { ...options, maxAge: tokens.expires_in ?? 3600 });
  jar.set(REFRESH, tokens.refresh_token, { ...options, maxAge: 60 * 60 * 24 * 30 });
  jar.set(EXPIRES, String(Math.floor(Date.now() / 1000) + (tokens.expires_in ?? 3600)), { ...options, maxAge: 60 * 60 * 24 * 30 });
  return true;
}

/** Só em Server Action / route handler (grava cookie). */
export async function signIn(email: string, password: string): Promise<boolean> {
  const tokens = await authRequest("password", { email, password });
  return tokens ? store(tokens) : false;
}

/** Só em route handler (grava cookie). */
export async function refreshSession(): Promise<boolean> {
  const refresh = (await cookies()).get(REFRESH)?.value;
  if (!refresh) return false;
  const tokens = await authRequest("refresh_token", { refresh_token: refresh });
  return tokens ? store(tokens) : false;
}

export async function signOut(): Promise<void> {
  const jar = await cookies();
  for (const name of [ACCESS, REFRESH, EXPIRES]) jar.delete(name);
}

/** Access token válido (com folga de 30s) ou undefined. Leitura pura: serve em Server Components. */
export async function accessToken(): Promise<string | undefined> {
  const jar = await cookies();
  const token = jar.get(ACCESS)?.value;
  const exp = Number(jar.get(EXPIRES)?.value ?? 0);
  return token && exp > Math.floor(Date.now() / 1000) + 30 ? token : undefined;
}

/** Páginas: sem sessão válida → renova (se houver refresh) ou vai para o login. */
export async function requireAccessToken(nextPath: string): Promise<string> {
  const token = await accessToken();
  if (token) return token;
  const hasRefresh = !!(await cookies()).get(REFRESH)?.value;
  redirect(`${hasRefresh ? "/auth/refresh" : "/login"}?next=${encodeURIComponent(safeNext(nextPath))}`);
}
