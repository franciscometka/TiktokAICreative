/**
 * L8.1 — status do worker para o shell. Pura (sem I/O): usada pela API (`GET /v1/worker`), pelo
 * modo local e pela UI. Os limites ficam SÓ aqui.
 *
 * - online: heartbeat recente (≤ WORKER_OFFLINE_AFTER_MS);
 * - offline: já houve heartbeat, mas ficou velho;
 * - unknown: nunca houve heartbeat ou não deu para consultar — NÃO é "offline" (sem evidência);
 * - local: modo local (`npm run dev`), o próprio servidor Next gera os vídeos.
 */

/** O worker grava presença a cada 30s… */
export const WORKER_HEARTBEAT_INTERVAL_MS = 30_000;
/** …e é considerado offline sem sinal por 2 min (4 batidas perdidas). */
export const WORKER_OFFLINE_AFTER_MS = 120_000;
/** A UI reconsulta o status neste intervalo (só com a aba visível). */
export const WORKER_STATUS_POLL_MS = 30_000;

export type WorkerState = "online" | "offline" | "unknown" | "local";

export interface WorkerStatusView {
  state: WorkerState;
  /** ISO do último heartbeat (null em unknown/local). */
  lastSeenAt: string | null;
}

export function workerStatusFrom(lastHeartbeatAt: string | Date | null, now: Date = new Date()): WorkerStatusView {
  if (!lastHeartbeatAt) return { state: "unknown", lastSeenAt: null };
  const seen = lastHeartbeatAt instanceof Date ? lastHeartbeatAt : new Date(lastHeartbeatAt);
  if (Number.isNaN(seen.getTime())) return { state: "unknown", lastSeenAt: null };
  const age = now.getTime() - seen.getTime();
  return { state: age <= WORKER_OFFLINE_AFTER_MS ? "online" : "offline", lastSeenAt: seen.toISOString() };
}

/** "agora" · "há 3 min" · "há 2 h" · "há 4 dias". */
export function lastSeenLabel(lastSeenAt: string | null, now: Date = new Date()): string | null {
  if (!lastSeenAt) return null;
  const seconds = Math.max(0, Math.round((now.getTime() - new Date(lastSeenAt).getTime()) / 1000));
  if (seconds < 60) return "agora";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `há ${hours} h`;
  const days = Math.floor(hours / 24);
  return `há ${days} ${days === 1 ? "dia" : "dias"}`;
}

export interface WorkerStatusCopy {
  label: string;
  title: string;
  lines: string[];
}

/** Textos amigáveis (nada técnico por padrão). */
export function workerStatusCopy(view: WorkerStatusView, now: Date = new Date()): WorkerStatusCopy {
  const seen = lastSeenLabel(view.lastSeenAt, now);
  switch (view.state) {
    case "online":
      return { label: "Worker online", title: "Worker conectado", lines: ["Pronto para gerar vídeos", `Último contato: ${seen ?? "agora"}`] };
    case "offline":
      return {
        label: "Worker offline", title: "Seu computador de geração está offline.",
        lines: ["Os projetos continuam na fila e serão processados quando o worker voltar.", ...(seen ? [`Último contato: ${seen}`] : [])],
      };
    case "local":
      return { label: "Geração local", title: "Modo local", lines: ["Os vídeos são gerados por este servidor."] };
    default:
      return { label: "Worker não verificado", title: "Ainda sem sinal do worker", lines: ["Assim que ele conectar, o status aparece aqui."] };
  }
}
