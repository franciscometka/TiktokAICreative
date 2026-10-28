import { NextResponse } from "next/server";
import { BUILD_RUNTIME_MODE, deployMisconfiguration, parseRuntimeMode } from "@/lib/runtime-mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Diagnóstico do DEPLOY do frontend (sem segredos): em qual modo este build foi gerado e se as
 * variáveis públicas do modo cloud chegaram a ESTE ambiente (Production/Preview). Só booleanos e
 * o host da API — nenhuma chave, nenhum token.
 */
export async function GET() {
  const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL;
  let apiHost: string | null = null;
  try { apiHost = apiBase ? new URL(apiBase).host : null; } catch { apiHost = "inválida"; }
  const misconfigured = deployMisconfiguration();
  return NextResponse.json({
    mode: parseRuntimeMode(process.env.NEXT_PUBLIC_RUNTIME_MODE),
    buildMode: BUILD_RUNTIME_MODE,
    vercelEnv: process.env.VERCEL_ENV ?? null,
    apiHost,
    supabaseUrlSet: !!process.env.NEXT_PUBLIC_SUPABASE_URL,
    supabaseAnonKeySet: !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    ok: !misconfigured,
    ...(misconfigured ? { problem: misconfigured } : {}),
  }, { status: misconfigured ? 503 : 200, headers: { "Cache-Control": "no-store" } });
}
