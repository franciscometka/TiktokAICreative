import { NextResponse } from "next/server";
import type { CreditsSummary } from "@/application/credits";
import type { ProjectCard } from "@/application/project-v2-view";
import type { WorkerStatusView } from "@/application/worker-status";
import { apiFetch, getBackendFor, type ReadBackend } from "@/server/backend";
import { accessToken, runtimeMode } from "@/server/session";

export const dynamic = "force-dynamic";

/**
 * L8.1 — dados do shell (worker + usuário), consultados pelo cliente por polling leve.
 * Local: o próprio Next gera (worker "local"). Cloud: Render API com o token da sessão; sem
 * sessão ou API fora do ar → "unknown" (nunca "offline" sem evidência). Nada técnico no corpo.
 * L8.8: o MESMO poll traz resumos de projetos e avatares (Command Palette + eventos de UX), sem
 * um segundo polling e sem dados pesados (só id, nome, status e duração).
 */

/** Resumo mínimo de projeto (palette, notificações). */
export interface ShellProject {
  id: string;
  name: string;
  status: ProjectCard["status"];
  statusLabel: string;
  durationLabel: string | null;
}

export interface ShellStatus {
  mode: "local" | "cloud";
  worker: WorkerStatusView;
  user: { label: string; initial: string } | null;
  /** L8.2: saldo do mês. null = indisponível (não configurado ou sem consulta) — nunca "0". */
  credits: CreditsSummary | null;
  /** L8.8: até `SHELL_PROJECT_LIMIT` projetos mais recentes; null = não consultado. */
  projects?: ShellProject[] | null;
  /** L8.8: avatares (nome + ativo) para a palette; null = não consultado. */
  avatars?: { id: string; name: string; active: boolean }[] | null;
}

export const SHELL_PROJECT_LIMIT = 20;
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

async function summaries(backend: ReadBackend): Promise<Pick<ShellStatus, "projects" | "avatars">> {
  const [projects, avatars] = await Promise.all([
    backend.projects("all").then((cards) => cards.slice(0, SHELL_PROJECT_LIMIT).map((c): ShellProject => ({ id: c.id, name: c.name, status: c.status, statusLabel: c.statusLabel, durationLabel: c.durationLabel }))).catch(() => null),
    backend.avatars().then((list) => list.map((a) => ({ id: a.id, name: a.name, active: a.active }))).catch(() => null),
  ]);
  return { projects, avatars };
}

export async function GET(): Promise<NextResponse<ShellStatus>> {
  const headers = { "Cache-Control": "no-store" };
  if (runtimeMode() === "local") {
    const backend = getBackendFor(undefined);
    const [credits, extra] = await Promise.all([backend.creditsSummary().catch(() => null), summaries(backend)]);
    return NextResponse.json({ mode: "local", worker: { state: "local", lastSeenAt: null }, user: { label: "Modo local", initial: "L" }, credits, ...extra }, { headers });
  }
  const token = await accessToken();
  if (!token) return NextResponse.json({ mode: "cloud", worker: UNKNOWN, user: null, credits: null, projects: null, avatars: null }, { headers });
  const backend = getBackendFor(token);
  const [credits, extra] = await Promise.all([backend.creditsSummary().catch(() => null), summaries(backend)]);
  let worker = UNKNOWN;
  try {
    const { json } = await apiFetch<{ ok: boolean; value: WorkerStatusView }>(token, "GET", "/v1/worker");
    // Só os dois campos conhecidos seguem para o cliente.
    if (json.ok && ["online", "offline", "unknown"].includes(json.value.state)) worker = { state: json.value.state, lastSeenAt: json.value.lastSeenAt ?? null };
  } catch {
    // API fora do ar: status desconhecido, sem alarmar.
  }
  return NextResponse.json({ mode: "cloud", worker, user: userFromToken(token), credits, ...extra }, { headers });
}
