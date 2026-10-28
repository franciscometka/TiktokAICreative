import { createHash } from "node:crypto";
import { WORKER_HEARTBEAT_INTERVAL_MS } from "@/application/worker-status";
import type { SqlExecutor } from "../db/sql";
import type { Logger } from "../logger";

/**
 * L8.1 — presença do worker (`worker_heartbeats`). Completamente separada da fila: não toca
 * job_queue, lease nem processamento. Guarda só um hash opaco do id do processo + horários.
 */

/** Hash opaco do id do worker (o id de processo contém hostname — nunca vai ao banco/API). */
export function workerKey(workerId: string): string {
  return createHash("sha256").update(`worker:${workerId}`).digest("hex").slice(0, 32);
}

export class WorkerHeartbeatRepository {
  constructor(private readonly db: SqlExecutor) {}

  /** Upsert da presença deste processo. */
  async beat(key: string, at: Date = new Date()): Promise<void> {
    await this.db.query(
      `insert into worker_heartbeats (worker_key, heartbeat_at) values ($1, $2)
       on conflict (worker_key) do update set heartbeat_at = excluded.heartbeat_at`,
      [key, at.toISOString()],
    );
  }

  /** Heartbeat mais recente de qualquer worker (null = nunca houve). */
  async latest(): Promise<string | null> {
    const { rows } = await this.db.query<{ at: Date | string | null }>("select max(heartbeat_at) as at from worker_heartbeats");
    const at = rows[0]?.at ?? null;
    return at === null ? null : new Date(at).toISOString();
  }
}

/**
 * Batida periódica, independente do loop de tarefas. Falha (banco instável) só vira log de aviso:
 * NUNCA derruba o worker nem interrompe a tarefa em andamento. Retorna `stop()`.
 */
export function startHeartbeat(options: { repo: Pick<WorkerHeartbeatRepository, "beat">; key: string; logger: Logger; intervalMs?: number }): { stop: () => void; beatNow: () => Promise<boolean> } {
  const { repo, key, logger } = options;
  let failing = false;
  const beatNow = async (): Promise<boolean> => {
    try {
      await repo.beat(key);
      if (failing) logger.info("heartbeat do worker voltou");
      failing = false;
      return true;
    } catch (error) {
      // Loga só na transição para não inundar o log a cada 30s.
      if (!failing) logger.warn("heartbeat do worker falhou (o processamento continua)", { error });
      failing = true;
      return false;
    }
  };
  void beatNow();
  const timer = setInterval(() => void beatNow(), options.intervalMs ?? WORKER_HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer), beatNow };
}
