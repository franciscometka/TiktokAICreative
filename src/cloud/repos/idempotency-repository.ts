import { createHash } from "node:crypto";
import { isUniqueViolation, type SqlClient } from "../db/sql";

/**
 * Idempotency keys (D107): o mesmo `Idempotency-Key` com o mesmo corpo devolve a MESMA resposta
 * (clique duplo, retry de rede, refresh). Mesmo key com corpo diferente = erro. Enquanto a
 * primeira execução não terminou, a segunda recebe "em andamento" em vez de executar de novo.
 */
export type IdempotencyStart =
  | { kind: "new" }
  | { kind: "replay"; status: number; body: unknown }
  | { kind: "in_progress" }
  | { kind: "mismatch" };

export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;

export function requestHash(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body ?? null)).digest("hex");
}

export class IdempotencyRepository {
  constructor(private readonly db: SqlClient) {}

  async start(userId: string, scope: string, key: string, hash: string): Promise<IdempotencyStart> {
    try {
      await this.db.query("insert into idempotency_keys (user_id, scope, key, request_hash) values ($1, $2, $3, $4)", [userId, scope, key, hash]);
      return { kind: "new" };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
    const row = (await this.db.query<{ request_hash: string; status_code: number | null; response: unknown }>(
      "select request_hash, status_code, response from idempotency_keys where user_id = $1 and scope = $2 and key = $3",
      [userId, scope, key],
    )).rows[0];
    if (!row) return { kind: "in_progress" };
    if (row.request_hash !== hash) return { kind: "mismatch" };
    if (row.status_code === null) return { kind: "in_progress" };
    return { kind: "replay", status: row.status_code, body: typeof row.response === "string" ? JSON.parse(row.response) : row.response };
  }

  async complete(userId: string, scope: string, key: string, status: number, body: unknown): Promise<void> {
    await this.db.query("update idempotency_keys set status_code = $4, response = $5::jsonb where user_id = $1 and scope = $2 and key = $3", [userId, scope, key, status, JSON.stringify(body)]);
  }

  /** Falha antes de responder: libera a chave para o usuário tentar de novo. */
  async release(userId: string, scope: string, key: string): Promise<void> {
    await this.db.query("delete from idempotency_keys where user_id = $1 and scope = $2 and key = $3 and status_code is null", [userId, scope, key]);
  }
}
