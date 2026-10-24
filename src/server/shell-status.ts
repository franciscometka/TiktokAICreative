import { createHash } from "node:crypto";
import type { ShellSummary } from "@/application/shell-summary";
import type { WorkerStatusView } from "@/application/worker-status";
import type { ReadBackend } from "./backend";

/**
 * L8.8.1 — monta o status do shell. Custo constante por poll: `backend.shell()` (projetos resumidos
 * priorizados + avatares + saldo) e `backend.worker()` em PARALELO. Nunca `backend.projects()`
 * (cards completos). Sem sessão → nada do usuário.
 */

export interface ShellStatus {
  mode: "local" | "cloud";
  worker: WorkerStatusView;
  user: { label: string; initial: string } | null;
  /** L8.2: saldo do mês. null = indisponível (não configurado ou sem consulta) — nunca "0". */
  credits: ShellSummary["credits"];
  /** L8.8: projetos resumidos (palette + eventos); null = não consultado. */
  projects?: ShellSummary["projects"] | null;
  /** L8.8: avatares (nome + ativo) para a palette; null = não consultado. */
  avatars?: ShellSummary["avatars"] | null;
  /**
   * L8.8.1: namespace das notificações no navegador. Opaco (hash do id da conta; nunca e-mail).
   * "local" no modo local; null = sem sessão (nada é lido nem gravado).
   */
  namespace?: string | null;
}

const UNKNOWN: WorkerStatusView = { state: "unknown", lastSeenAt: null };

/** Claims do JWT só para exibição/namespace (a assinatura é validada pela API a cada chamada). */
function claims(token: string): { sub?: unknown; email?: unknown } {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { sub?: unknown; email?: unknown };
  } catch {
    return {};
  }
}

/** Namespace opaco e estável por conta: hash do `sub` (sem dado pessoal na chave do navegador). */
export function notificationNamespace(token: string): string | null {
  const sub = claims(token).sub;
  return typeof sub === "string" && sub ? `u${createHash("sha256").update(`cf-notifications:${sub}`).digest("hex").slice(0, 20)}` : null;
}

export function userFromToken(token: string): ShellStatus["user"] {
  const email = claims(token).email;
  const label = (typeof email === "string" ? email : "").split("@")[0] || "Sua conta";
  return { label, initial: label.charAt(0).toUpperCase() || "•" };
}

function safeWorker(w: WorkerStatusView | null): WorkerStatusView {
  // Só os dois campos conhecidos seguem para o cliente.
  return w && ["online", "offline", "unknown"].includes(w.state) ? { state: w.state, lastSeenAt: w.lastSeenAt ?? null } : UNKNOWN;
}

export async function buildShellStatus(input: { mode: "local"; backend: Pick<ReadBackend, "shell"> } | { mode: "cloud"; token: string | undefined; backend: Pick<ReadBackend, "shell" | "worker"> | null }): Promise<ShellStatus> {
  if (input.mode === "local") {
    const summary = await input.backend.shell().catch(() => null);
    return { mode: "local", worker: { state: "local", lastSeenAt: null }, user: { label: "Modo local", initial: "L" }, credits: summary?.credits ?? null, projects: summary?.projects ?? null, avatars: summary?.avatars ?? null, namespace: "local" };
  }
  if (!input.token || !input.backend) return { mode: "cloud", worker: UNKNOWN, user: null, credits: null, projects: null, avatars: null, namespace: null };
  const [summary, worker] = await Promise.all([input.backend.shell().catch(() => null), input.backend.worker().catch(() => null)]);
  return { mode: "cloud", worker: safeWorker(worker), user: userFromToken(input.token), credits: summary?.credits ?? null, projects: summary?.projects ?? null, avatars: summary?.avatars ?? null, namespace: notificationNamespace(input.token) };
}
