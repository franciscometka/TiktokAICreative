import { NextResponse } from "next/server";
import type { CreditsSummary } from "@/application/credits";
import type { WorkerStatusView } from "@/application/worker-status";
import { apiFetch, getBackendFor } from "@/server/backend";
import { accessToken, runtimeMode } from "@/server/session";

export const dynamic = "force-dynamic";

/**
 * L8.1 — dados do shell (worker + usuário), consultados pelo cliente por polling leve.
 * Local: o próprio Next gera (worker "local"). Cloud: Render API com o token da sessão; sem
 * sessão ou API fora do ar → "unknown" (nunca "offline" sem evidência). Nada técnico no corpo.
 */

export interface ShellStatus {
  mode: "local" | "cloud";
  worker: WorkerStatusView;
  user: { label: string; initial: string } | null;
  /** L8.2: saldo do mês. null = indisponível (não configurado ou sem consulta) — nunca "0". */
  credits: CreditsSummary | null;
}

const UNKNOWN: WorkerStatusView = { state: "unknown", lastSeenAt: null };

/** Só para exibição: o e-mail do próprio usuário vem do JWT da sessão (já validado pela API). */
function userFromToken(token: string): ShellStatus["user"] {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { email?: unknown };
    const email = typeof payload.email === "string" ? payload.email : "";
    const label = email.split("@")[0] || "Sua conta";
    return { label, initial: label.charAt(0).toUpperCase() || "•" };
  } catch {
    return { label: "Sua conta", initial: "•" };
  }
}

export async function GET(): Promise<NextResponse<ShellStatus>> {
  const headers = { "Cache-Control": "no-store" };
  if (runtimeMode() === "local") {
    const credits = await getBackendFor(undefined).creditsSummary().catch(() => null);
    return NextResponse.json({ mode: "local", worker: { state: "local", lastSeenAt: null }, user: { label: "Modo local", initial: "L" }, credits }, { headers });
  }
  const token = await accessToken();
  if (!token) return NextResponse.json({ mode: "cloud", worker: UNKNOWN, user: null, credits: null }, { headers });
  const credits = await getBackendFor(token).creditsSummary().catch(() => null);
  let worker = UNKNOWN;
  try {
    const { json } = await apiFetch<{ ok: boolean; value: WorkerStatusView }>(token, "GET", "/v1/worker");
    // Só os dois campos conhecidos seguem para o cliente.
    if (json.ok && ["online", "offline", "unknown"].includes(json.value.state)) worker = { state: json.value.state, lastSeenAt: json.value.lastSeenAt ?? null };
  } catch {
    // API fora do ar: status desconhecido, sem alarmar.
  }
  return NextResponse.json({ mode: "cloud", worker, user: userFromToken(token), credits }, { headers });
}
