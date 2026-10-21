import { z } from "zod";
import type { Campaign, GenerationJob } from "@/domain/pipeline";
import { isPaidRun, jobKey, planningKey, type ActivitySnapshot, type JobRun, type WorkDispatcher } from "@/pipeline/dispatch";
import { isUniqueViolation, type SqlClient } from "../db/sql";

/**
 * Fila DURÁVEL no próprio Postgres do Supabase (D103) — sem serviço extra.
 *
 * Claim: UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING. Dois workers
 * nunca pegam a mesma tarefa; um índice único parcial impede duas tarefas `running` da mesma
 * campanha (as operações de uma campanha continuam serializadas, como no processo local).
 * Lease + heartbeat: worker que morre libera a tarefa quando o lease expira; a retomada decide
 * entre requeue (seguro) e `blocked` (operação paga incerta) — nunca reenvia pago sozinha.
 * Dedupe: uma tarefa ativa (queued/running) por chave — clique duplo/spam não duplica.
 */

export const QUEUE_STATUSES = ["queued", "running", "awaiting_approval", "blocked", "failed", "completed"] as const;
export type QueueStatus = (typeof QUEUE_STATUSES)[number];

export const TaskPayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("planning"), planningRunId: z.string().min(1), realAuthorized: z.boolean() }),
  z.object({ kind: z.literal("job_run"), run: z.record(z.string(), z.unknown()).transform((r) => r as unknown as JobRun) }),
]);
export type TaskPayload = z.infer<typeof TaskPayloadSchema>;

export interface QueueTask {
  id: string;
  userId: string;
  campaignId: string;
  jobId: string | null;
  kind: "planning" | "job_run";
  payload: TaskPayload;
  paid: boolean;
  dedupeKey: string;
  status: QueueStatus;
  attempts: number;
  maxAttempts: number;
  lockedBy: string | null;
  leaseExpiresAt: string | null;
  outcome: string | null;
  lastError: string | null;
  blockedReason: string | null;
  createdAt: string;
  updatedAt: string;
}

type Row = { id: string; user_id: string; campaign_id: string; job_id: string | null; kind: QueueTask["kind"]; payload: unknown; paid: boolean; dedupe_key: string; status: QueueStatus; attempts: number; max_attempts: number; locked_by: string | null; lease_expires_at: Date | string | null; outcome: string | null; last_error: string | null; blocked_reason: string | null; created_at: Date | string; updated_at: Date | string };
const iso = (v: Date | string | null) => (v === null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString());
const toTask = (r: Row): QueueTask => ({
  id: r.id, userId: r.user_id, campaignId: r.campaign_id, jobId: r.job_id, kind: r.kind,
  payload: TaskPayloadSchema.parse(typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload),
  paid: r.paid, dedupeKey: r.dedupe_key, status: r.status, attempts: r.attempts, maxAttempts: r.max_attempts, lockedBy: r.locked_by,
  leaseExpiresAt: iso(r.lease_expires_at), outcome: r.outcome, lastError: r.last_error, blockedReason: r.blocked_reason,
  createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)!,
});

export interface EnqueueInput {
  userId: string;
  campaignId: string;
  jobId: string | null;
  payload: TaskPayload;
  paid: boolean;
  dedupeKey: string;
  maxAttempts?: number;
}

export class PostgresJobQueue {
  constructor(private readonly db: SqlClient) {}

  /** Persiste a tarefa. Já existe uma ativa com a mesma chave → devolve a existente (sem duplicar). */
  async enqueue(input: EnqueueInput): Promise<{ task: QueueTask; created: boolean }> {
    try {
      const r = await this.db.query<Row>(
        `insert into job_queue (user_id, campaign_id, job_id, kind, payload, paid, dedupe_key, status, max_attempts)
         values ($1, $2, $3, $4, $5::jsonb, $6, $7, 'queued', $8) returning *`,
        [input.userId, input.campaignId, input.jobId, input.payload.kind, JSON.stringify(input.payload), input.paid, input.dedupeKey, input.maxAttempts ?? 3],
      );
      return { task: toTask(r.rows[0]!), created: true };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.db.query<Row>("select * from job_queue where dedupe_key = $1 and status in ('queued','running') and user_id = $2 limit 1", [input.dedupeKey, input.userId]);
      if (!existing.rows[0]) throw error;
      return { task: toTask(existing.rows[0]), created: false };
    }
  }

  /** Claim transacional e exclusivo. undefined = nada disponível (ou corrida perdida: tente de novo). */
  async claim(workerId: string, leaseSeconds: number): Promise<QueueTask | undefined> {
    try {
      const r = await this.db.query<Row>(
        `update job_queue q set status = 'running', attempts = q.attempts + 1, locked_by = $1, locked_at = now(), heartbeat_at = now(),
           lease_expires_at = now() + make_interval(secs => $2), updated_at = now()
         where q.id = (
           select c.id from job_queue c
           where c.status = 'queued' and c.run_after <= now()
             and not exists (select 1 from job_queue r where r.campaign_id = c.campaign_id and r.status = 'running')
           order by c.created_at
           for update skip locked
           limit 1)
         returning q.*`,
        [workerId, leaseSeconds],
      );
      return r.rows[0] ? toTask(r.rows[0]) : undefined;
    } catch (error) {
      // Outro worker assumiu uma tarefa da mesma campanha no mesmo instante.
      if (isUniqueViolation(error)) return undefined;
      throw error;
    }
  }

  /** Renova o lease. false = a tarefa não é mais deste worker (foi recuperada): pare de escrever. */
  async heartbeat(taskId: string, workerId: string, leaseSeconds: number): Promise<boolean> {
    const r = await this.db.query(
      "update job_queue set heartbeat_at = now(), lease_expires_at = now() + make_interval(secs => $3), updated_at = now() where id = $1 and locked_by = $2 and status = 'running'",
      [taskId, workerId, leaseSeconds],
    );
    return r.rowCount > 0;
  }

  async finish(taskId: string, workerId: string, result: { status: Exclude<QueueStatus, "queued" | "running">; outcome: string; error?: string; blockedReason?: string }): Promise<boolean> {
    const r = await this.db.query(
      `update job_queue set status = $3, outcome = $4, last_error = $5, blocked_reason = $6, finished_at = now(), updated_at = now(), lease_expires_at = null
       where id = $1 and locked_by = $2 and status = 'running'`,
      [taskId, workerId, result.status, result.outcome.slice(0, 120), result.error?.slice(0, 1000) ?? null, result.blockedReason?.slice(0, 500) ?? null],
    );
    return r.rowCount > 0;
  }

  /** Tarefas `running` cujo lease expirou (worker morreu/deploy/timeout). */
  async expired(limit = 20): Promise<QueueTask[]> {
    const r = await this.db.query<Row>("select * from job_queue where status = 'running' and lease_expires_at < now() order by lease_expires_at limit $1", [limit]);
    return r.rows.map(toTask);
  }

  /**
   * Aplica a decisão da retomada SÓ se a tarefa ainda está expirada (um heartbeat atrasado
   * vence a corrida). requeue volta para a fila; block/fail encerram aguardando o usuário.
   */
  async recover(taskId: string, decision: { action: "requeue" } | { action: "block"; reason: string } | { action: "fail"; reason: string }): Promise<boolean> {
    const r = decision.action === "requeue"
      ? await this.db.query("update job_queue set status = 'queued', locked_by = null, lease_expires_at = null, run_after = now(), updated_at = now(), last_error = 'retomada após queda do worker' where id = $1 and status = 'running' and lease_expires_at < now()", [taskId])
      : await this.db.query(
          "update job_queue set status = $2, blocked_reason = $3, last_error = $3, outcome = 'recovered', locked_by = null, lease_expires_at = null, finished_at = now(), updated_at = now() where id = $1 and status = 'running' and lease_expires_at < now()",
          [taskId, decision.action === "block" ? "blocked" : "failed", decision.reason.slice(0, 500)],
        );
    return r.rowCount > 0;
  }

  /** Chaves com execução ativa do usuário (para o API saber que NÃO está interrompido). */
  async activeKeys(userId: string): Promise<Set<string>> {
    const r = await this.db.query<{ dedupe_key: string }>("select dedupe_key from job_queue where user_id = $1 and status in ('queued','running')", [userId]);
    return new Set(r.rows.map((row) => row.dedupe_key));
  }

  async latest(userId: string, dedupeKey: string): Promise<QueueTask | undefined> {
    const r = await this.db.query<Row>("select * from job_queue where user_id = $1 and dedupe_key = $2 order by created_at desc limit 1", [userId, dedupeKey]);
    return r.rows[0] ? toTask(r.rows[0]) : undefined;
  }

  async get(taskId: string): Promise<QueueTask | undefined> {
    const r = await this.db.query<Row>("select * from job_queue where id = $1", [taskId]);
    return r.rows[0] ? toTask(r.rows[0]) : undefined;
  }

  async counts(): Promise<Record<QueueStatus, number>> {
    const r = await this.db.query<{ status: QueueStatus; n: string | number }>("select status, count(*) as n from job_queue group by status", []);
    const out = Object.fromEntries(QUEUE_STATUSES.map((s) => [s, 0])) as Record<QueueStatus, number>;
    for (const row of r.rows) out[row.status] = Number(row.n);
    return out;
  }
}

/** WorkDispatcher do cloud: o PipelineService da API só persiste tarefas aqui. */
export class QueueDispatcher implements WorkDispatcher {
  constructor(private readonly queue: PostgresJobQueue, private readonly userId: string) {}

  async enqueuePlanning(campaign: Campaign, realAuthorized: boolean): Promise<void> {
    if (!campaign.planningRunId) throw new Error("Planejamento sem execução registrada");
    await this.queue.enqueue({
      userId: this.userId, campaignId: campaign.id, jobId: null, dedupeKey: planningKey(campaign.id),
      payload: { kind: "planning", planningRunId: campaign.planningRunId, realAuthorized },
      paid: isPaidRun({ kind: "planning", real: realAuthorized || campaign.plannerId === "anthropic" }),
      maxAttempts: 1,
    });
  }

  async enqueueJob(job: Pick<GenerationJob, "id" | "campaignId" | "stageModes">, run: JobRun): Promise<void> {
    await this.queue.enqueue({
      userId: this.userId, campaignId: job.campaignId, jobId: job.id, dedupeKey: jobKey(job.id),
      payload: { kind: "job_run", run }, paid: isPaidRun(run, job),
    });
  }
}

export class SetActivity implements ActivitySnapshot {
  constructor(private readonly keys: ReadonlySet<string>) {}
  isActive(key: string): boolean {
    return this.keys.has(key);
  }
}
