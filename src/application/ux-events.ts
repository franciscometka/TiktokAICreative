import { formatCredits } from "@/costs/credits";
import type { CreditsSummary } from "./credits";
import { videosLabel } from "./credits";
import type { ProjectStatus } from "./project-v2-view";
import type { WorkerState } from "./worker-status";

/**
 * L8.8 — camada ÚNICA de eventos de UX. Compara o snapshot anterior com o atual (dados que o shell
 * JÁ consulta: worker, créditos e projetos resumidos) e produz eventos. Pura e determinística:
 * - snapshot anterior null (primeiro load) = baseline → NENHUM evento;
 * - nada mudou → nenhum evento;
 * - cada evento tem `key` estável (a central e os toasts deduplicam por ela).
 */

export interface ProjectSnapshot {
  id: string;
  name: string;
  status: ProjectStatus;
  durationLabel: string | null;
}

export interface UxSnapshot {
  worker: WorkerState | null;
  credits: Pick<CreditsSummary, "state" | "remaining" | "estimatedVideos"> | null;
  projects: readonly ProjectSnapshot[];
}

export type UxEventKind = "project.completed" | "project.needs_approval" | "project.attention" | "worker.offline" | "worker.online" | "credits.low" | "credits.empty";

export interface UxEvent {
  key: string;
  kind: UxEventKind;
  tone: "success" | "info" | "warning" | "danger";
  title: string;
  description: string;
  href: string | null;
  actionLabel: string | null;
  at: string;
}

const IN_PRODUCTION: readonly ProjectStatus[] = ["preparing", "queued", "generating"];
const ATTENTION: readonly ProjectStatus[] = ["attention", "failed", "blocked"];

/** Período dos créditos para a chave (o corte é mensal; um aviso por limiar por mês). */
export function creditsPeriodKey(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function projectEvent(prev: ProjectSnapshot, next: ProjectSnapshot, at: string): UxEvent | null {
  if (prev.status === next.status) return null;
  const href = `/campaigns/${encodeURIComponent(next.id)}`;
  const detail = [next.name, next.durationLabel].filter(Boolean).join(" · ");
  if (next.status === "ready") {
    return { key: `project:${next.id}:completed`, kind: "project.completed", tone: "success", title: "Seu vídeo está pronto", description: detail, href, actionLabel: "Ver resultado", at };
  }
  if (next.status === "awaiting_approval" && IN_PRODUCTION.includes(prev.status)) {
    return { key: `project:${next.id}:needs-approval:${prev.status}`, kind: "project.needs_approval", tone: "info", title: "Seu projeto precisa da sua aprovação", description: next.name, href, actionLabel: "Revisar", at };
  }
  if (ATTENTION.includes(next.status) && !ATTENTION.includes(prev.status)) {
    const title = next.status === "blocked" ? "Geração pausada por segurança" : next.status === "failed" ? "Não conseguimos concluir um projeto" : "Um projeto precisa de atenção";
    return { key: `project:${next.id}:${next.status}`, kind: "project.attention", tone: next.status === "failed" ? "danger" : "warning", title, description: next.name, href, actionLabel: "Abrir projeto", at };
  }
  return null;
}

export function diffSnapshots(prev: UxSnapshot | null, next: UxSnapshot, now: Date = new Date()): UxEvent[] {
  if (!prev) return [];
  const at = now.toISOString();
  const events: UxEvent[] = [];

  // Projetos: só transições de projetos que JÁ estavam no snapshot anterior (novo projeto = criado agora).
  const before = new Map(prev.projects.map((p) => [p.id, p]));
  for (const project of next.projects) {
    const old = before.get(project.id);
    const event = old ? projectEvent(old, project, at) : null;
    if (event) events.push(event);
  }

  // Worker: só online ↔ offline. "unknown" (ou local) nunca gera alerta.
  if (prev.worker === "online" && next.worker === "offline") {
    events.push({ key: `worker:offline:${at}`, kind: "worker.offline", tone: "warning", title: "Worker offline", description: "Os projetos continuam na fila e seguem quando ele voltar.", href: null, actionLabel: null, at });
  }
  if (prev.worker === "offline" && next.worker === "online") {
    events.push({ key: `worker:online:${at}`, kind: "worker.online", tone: "success", title: "Worker conectado de novo", description: "A geração continua normalmente.", href: null, actionLabel: null, at });
  }

  // Créditos: só ao CRUZAR o limiar do L8.2 (low ≤ 20%, empty = 0).
  if (prev.credits && next.credits && prev.credits.state !== next.credits.state) {
    const period = creditsPeriodKey(now);
    const equivalence = videosLabel(next.credits);
    if (next.credits.state === "empty") {
      events.push({ key: `credits:empty:${period}`, kind: "credits.empty", tone: "danger", title: "Seus créditos acabaram", description: "Não há saldo neste mês.", href: "/credits", actionLabel: "Ver créditos", at });
    } else if (next.credits.state === "low" && prev.credits.state === "normal") {
      events.push({ key: `credits:low:${period}`, kind: "credits.low", tone: "warning", title: "Seus créditos estão baixos", description: [`Restam ${formatCredits(next.credits.remaining)} créditos neste mês.`, equivalence].filter(Boolean).join(" "), href: "/credits", actionLabel: "Ver créditos", at });
    }
  }
  return events;
}

/** Quais eventos também viram toast (feedback imediato). O resto fica só na central. */
export function toastFor(event: UxEvent, pathname: string): boolean {
  if (event.kind === "project.completed") return event.href !== pathname; // na própria página o resultado já aparece
  return event.kind === "worker.offline" || event.kind === "worker.online" || event.kind === "credits.low" || event.kind === "credits.empty";
}
