import { GenerationCostSchema, type GenerationCost } from "@/domain/cost";
import { LlmCallRecordSchema, type LlmCallRecord } from "@/domain/llm";
import type { CostLedger } from "@/costs/ledger";
import type { LlmCallLog } from "@/storage/llm-call-log";
import { CorruptedDataError } from "@/storage/atomic-file";
import { isUniqueViolation, type SqlClient } from "../db/sql";
import { timestamp } from "../db/time";

/**
 * Ledger append-only no Postgres. O banco também recusa UPDATE/DELETE (trigger). Os valores
 * vêm SEMPRE do servidor (cálculo do pipeline sobre usage/preço); nada do browser entra aqui.
 * Colunas: job, attempt, stage, provider, model, custo estimado (quando houver), custo
 * confirmado, moeda, status e timestamp; o registro completo fica em `entry`.
 */
export class PostgresCostLedger implements CostLedger {
  constructor(private readonly db: SqlClient, readonly userId: string) {}

  async record(entry: GenerationCost): Promise<void> {
    const e = GenerationCostSchema.parse(entry);
    try {
      await this.db.query(
        `insert into ledger_entries (id, user_id, campaign_id, job_id, attempt_id, llm_call_id, stage, operation, provider, model,
           estimated_cost_brl, confirmed_cost_usd, confirmed_cost_brl, currency, status, entry, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, null, $11, $12, 'BRL', $13, $14::jsonb, $15)`,
        [e.id, this.userId, e.campaignId, e.jobId, e.attemptId, e.llmCallId, e.category, e.operation, e.provider, e.model,
          e.costUsd, e.costBrl, e.simulated ? "simulated" : "confirmed", JSON.stringify(e), timestamp(e.createdAt)],
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw new Error(`Registro de custo duplicado: ${e.id}`);
      throw error;
    }
  }

  async list(filter: { campaignId?: string; jobId?: string | null } = {}): Promise<readonly GenerationCost[]> {
    const where = ["user_id = $1"];
    const params: unknown[] = [this.userId];
    if (filter.campaignId !== undefined) { params.push(filter.campaignId); where.push(`campaign_id = $${params.length}`); }
    if (filter.jobId === null) where.push("job_id is null");
    else if (filter.jobId !== undefined) { params.push(filter.jobId); where.push(`job_id = $${params.length}`); }
    const r = await this.db.query<{ entry: unknown }>(`select entry from ledger_entries where ${where.join(" and ")} order by created_at, id`, params);
    return r.rows.map((row) => {
      try { return Object.freeze(GenerationCostSchema.parse(typeof row.entry === "string" ? JSON.parse(row.entry) : row.entry)); }
      catch (error) { throw new CorruptedDataError(`Ledger ilegível: ${error instanceof Error ? error.message.slice(0, 200) : "inválido"}`); }
    });
  }
}

export class PostgresLlmCallLog implements LlmCallLog {
  constructor(private readonly db: SqlClient, readonly userId: string) {}

  async record(entry: LlmCallRecord): Promise<void> {
    const e = LlmCallRecordSchema.parse(entry);
    await this.db.query("insert into llm_calls (id, user_id, campaign_id, record) values ($1, $2, $3, $4::jsonb)", [e.id, this.userId, e.campaignId, JSON.stringify(e)]);
  }

  async list(filter: { campaignId?: string } = {}): Promise<readonly LlmCallRecord[]> {
    const r = filter.campaignId === undefined
      ? await this.db.query<{ record: unknown }>("select record from llm_calls where user_id = $1 order by created_at, id", [this.userId])
      : await this.db.query<{ record: unknown }>("select record from llm_calls where user_id = $1 and campaign_id = $2 order by created_at, id", [this.userId, filter.campaignId]);
    return r.rows.map((row) => Object.freeze(LlmCallRecordSchema.parse(typeof row.record === "string" ? JSON.parse(row.record) : row.record)));
  }
}
