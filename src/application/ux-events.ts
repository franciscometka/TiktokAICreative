import { formatCredits } from "@/costs/credits";
import type { CreditsSummary } from "./credits";
import { videosLabel } from "./credits";
import type { ProjectStatus } from "./project-v2-view";
import type { WorkerState } from "./worker-status";

/**
 * L8.8 / L8.8.1 — camada ÚNICA de eventos de UX. A cada snapshot (dados que o shell JÁ consulta:
 * worker, créditos e projetos resumidos) `stepUx` compara com a MEMÓRIA e produz eventos. Pura:
 * - primeiro snapshot = baseline → nenhum evento; nada mudou → nenhum evento;
 * - identidade do evento vem do SERVIDOR (render id, momento da gravação do job, heartbeat do
 *   worker, período/franquia dos créditos) — nunca do relógio do cliente;
 * - créditos: erro temporário (null) NÃO apaga o último valor válido;
 * - worker: um aviso por queda (cooldown) e recuperação só depois de confirmada (sem spam de flapping).
 */

export interface ProjectSnapshot {
  id: string;
  name: string;
  status: ProjectStatus;
  durationLabel: string | null;
  /** Identidade durável do estado (ShellProject.episode). */
  episode: string;
}

export type CreditsSnapshot = Pick<CreditsSummary, "state" | "remaining" | "allowance" | "estimatedVideos" | "periodStart">;

export interface UxSnapshot {
  worker: { state: WorkerState; lastSeenAt: string | null } | null;
  /** null = indisponível agora (erro/configuração) — não é "zero". */
  credits: CreditsSnapshot | null;
  /** null = não consultado nesta resposta (mantém os anteriores). */
  projects: readonly ProjectSnapshot[] | null;
}

/** Valores centralizados das notificações do worker (o status VISUAL não espera nada disso). */
export const WORKER_NOTIFY = {
  /** Depois de um aviso de queda, outro só após este intervalo. */
  cooldownMs: 10 * 60_000,
  /** Recuperação só é anunciada depois de N snapshots seguidos online. */
  confirmOnlinePolls: 2,
} as const;

export interface UxMemory {
  projects: readonly ProjectSnapshot[] | null;
  /** Último saldo VÁLIDO conhecido (erro temporário não substitui). */
  credits: CreditsSnapshot | null;
  worker: {
    last: WorkerState | null;
    /** Queda em aberto: chave do aviso (null = suprimido pelo cooldown) e quando foi. */
    open: { key: string | null } | null;
    lastAlertAtMs: number | null;
    onlineStreak: number;
  };
}

export const EMPTY_MEMORY: UxMemory = { projects: null, credits: null, worker: { last: null, open: null, lastAlertAtMs: null, onlineStreak: 0 } };

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

function projectEvent(prev: ProjectSnapshot, next: ProjectSnapshot, at: string): UxEvent | null {
  const href = `/campaigns/${encodeURIComponent(next.id)}`;
  const detail = [next.name, next.durationLabel].filter(Boolean).join(" · ");
  // Pronto: nova versão do render também conta (mesmo sem ter visto o estado intermediário).
  if (next.status === "ready" && (prev.status !== "ready" || prev.episode !== next.episode)) {
    return { key: `project:${next.id}:completed:${next.episode}`, kind: "project.completed", tone: "success", title: "Seu vídeo está pronto", description: detail, href, actionLabel: "Ver resultado", at };
  }
  if (prev.status === next.status) return null;
  if (next.status === "awaiting_approval" && IN_PRODUCTION.includes(prev.status)) {
    return { key: `project:${next.id}:needs-approval:${next.episode}`, kind: "project.needs_approval", tone: "info", title: "Seu projeto precisa da sua aprovação", description: next.name, href, actionLabel: "Revisar", at };
  }
  if (ATTENTION.includes(next.status) && !ATTENTION.includes(prev.status)) {
    const title = next.status === "blocked" ? "Geração pausada por segurança" : next.status === "failed" ? "Não conseguimos concluir um projeto" : "Um projeto precisa de atenção";
    return { key: `project:${next.id}:${next.status}:${next.episode}`, kind: "project.attention", tone: next.status === "failed" ? "danger" : "warning", title, description: next.name, href, actionLabel: "Abrir projeto", at };
  }
  return null;
}

function stepWorker(mem: UxMemory["worker"], next: UxSnapshot["worker"], nowMs: number, at: string): { mem: UxMemory["worker"]; events: UxEvent[] } {
  if (!next) return { mem, events: [] };
  const events: UxEvent[] = [];
  let { open, lastAlertAtMs, onlineStreak } = mem;
  if (next.state === "offline") {
    onlineStreak = 0;
    // Só uma queda observada a partir de "online" (baseline/unknown/local nunca alertam).
    if (!open && mem.last === "online") {
      const cooled = lastAlertAtMs === null || nowMs - lastAlertAtMs >= WORKER_NOTIFY.cooldownMs;
      const key = cooled ? `worker:offline:${next.lastSeenAt ?? "unknown"}` : null;
      if (key) {
        events.push({ key, kind: "worker.offline", tone: "warning", title: "Worker offline", description: "Os projetos continuam na fila e seguem quando ele voltar.", href: null, actionLabel: null, at });
        lastAlertAtMs = nowMs;
      }
      open = { key };
    }
  } else if (next.state === "online") {
    onlineStreak = mem.last === "online" ? onlineStreak + 1 : 1;
    if (open && onlineStreak >= WORKER_NOTIFY.confirmOnlinePolls) {
      if (open.key) events.push({ key: `worker:recovered:${open.key}`, kind: "worker.online", tone: "success", title: "Worker conectado de novo", description: "A geração continua normalmente.", href: null, actionLabel: null, at });
      open = null;
    }
  } else {
    onlineStreak = 0; // unknown/local: silencioso, sem mexer na queda em aberto.
  }
  return { mem: { last: next.state, open, lastAlertAtMs, onlineStreak }, events };
}

function stepCredits(prev: CreditsSnapshot | null, next: CreditsSnapshot | null, at: string): { mem: CreditsSnapshot | null; events: UxEvent[] } {
  // Erro temporário: mantém o último válido para a próxima comparação.
  if (!next) return { mem: prev, events: [] };
  // Primeiro valor válido ou mês novo: vira referência (sem aviso retroativo).
  if (!prev || prev.periodStart !== next.periodStart || prev.state === next.state) return { mem: next, events: [] };
  // Episódio = período + franquia: no mesmo mês, sem mudar a franquia, o saldo só cai (um aviso por limiar).
  const episode = `${next.periodStart}:${next.allowance}`;
  if (next.state === "empty") {
    return { mem: next, events: [{ key: `credits:empty:${episode}`, kind: "credits.empty", tone: "danger", title: "Seus créditos acabaram", description: "Não há saldo neste mês.", href: "/credits", actionLabel: "Ver créditos", at }] };
  }
  if (next.state === "low" && prev.state === "normal") {
    const equivalence = videosLabel(next);
    return { mem: next, events: [{ key: `credits:low:${episode}`, kind: "credits.low", tone: "warning", title: "Seus créditos estão baixos", description: [`Restam ${formatCredits(next.remaining)} créditos neste mês.`, equivalence].filter(Boolean).join(" "), href: "/credits", actionLabel: "Ver créditos", at }] };
  }
  return { mem: next, events: [] };
}

/** Um passo: memória + snapshot → eventos + nova memória. Memória null = primeiro load (baseline). */
export function stepUx(memory: UxMemory | null, next: UxSnapshot, now: Date = new Date()): { events: UxEvent[]; memory: UxMemory } {
  const at = now.toISOString();
  const nowMs = now.getTime();
  const base = memory ?? EMPTY_MEMORY;
  const events: UxEvent[] = [];

  // Projetos: só transições de projetos que JÁ estavam no snapshot anterior (novo projeto = criado agora).
  const projects = next.projects ?? base.projects;
  if (memory?.projects && next.projects) {
    const before = new Map(memory.projects.map((p) => [p.id, p]));
    for (const p of next.projects) {
      const old = before.get(p.id);
      const e = old ? projectEvent(old, p, at) : null;
      if (e) events.push(e);
    }
  }

  // Primeiro load: worker e créditos só viram referência.
  const worker = memory ? stepWorker(base.worker, next.worker, nowMs, at) : { mem: { ...base.worker, last: next.worker?.state ?? null }, events: [] };
  const credits = memory ? stepCredits(base.credits, next.credits, at) : { mem: next.credits ?? null, events: [] };
  events.push(...worker.events, ...credits.events);

  return { events, memory: { projects, credits: credits.mem, worker: worker.mem } };
}

/** Compatível com o L8.8: um passo sem memória extra (prev = snapshot anterior). */
export function diffSnapshots(prev: UxSnapshot | null, next: UxSnapshot, now: Date = new Date()): UxEvent[] {
  if (!prev) return [];
  const seeded = stepUx(null, prev, now).memory;
  return stepUx(seeded, next, now).events;
}

/** Quais eventos também viram toast (feedback imediato). O resto fica só na central. */
export function toastFor(event: UxEvent, pathname: string): boolean {
  if (event.kind === "project.completed") return event.href !== pathname; // na própria página o resultado já aparece
  return event.kind === "worker.offline" || event.kind === "worker.online" || event.kind === "credits.low" || event.kind === "credits.empty";
}
