import pg from "pg";
import { isLockNotAvailable, LockTimeoutError, type QueryResult, type SqlClient, type SqlExecutor } from "./sql";

/**
 * node-postgres sobre o Postgres do Supabase. Use a connection string do pooler em modo
 * SESSION (porta 5432) para que advisory locks e transações fiquem na mesma conexão.
 * A URL (com senha) nunca é logada.
 */
export class PgSqlClient implements SqlClient {
  private readonly pool: pg.Pool;

  constructor(options: { connectionString: string; max?: number; ssl?: boolean; applicationName?: string }) {
    this.pool = new pg.Pool({
      connectionString: options.connectionString,
      max: options.max ?? 5,
      ...(options.ssl ? { ssl: { rejectUnauthorized: false } } : {}),
      application_name: options.applicationName ?? "tiktok-ai",
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    // Erro de conexão ociosa não derruba o processo; a próxima query reconecta.
    this.pool.on("error", () => undefined);
  }

  async query<T>(text: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
    const result = await this.pool.query(text, params as unknown[]);
    return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
  }

  async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const tx: SqlExecutor = {
      query: async <R>(text: string, params: readonly unknown[] = []) => {
        const r = await client.query(text, params as unknown[]);
        return { rows: r.rows as R[], rowCount: r.rowCount ?? 0 };
      },
    };
    try {
      await client.query("begin");
      const result = await fn(tx);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async withLock<T>(key: string, fn: () => Promise<T>, options: { timeoutMs?: number } = {}): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("select set_config('lock_timeout', $1, false)", [`${options.timeoutMs ?? 10_000}ms`]);
      try {
        await client.query("select pg_advisory_lock(hashtextextended($1, 0))", [key]);
      } catch (error) {
        if (isLockNotAvailable(error)) throw new LockTimeoutError("Este projeto está sendo processado agora. Tente de novo em instantes.");
        throw error;
      }
      try {
        return await fn();
      } finally {
        await client.query("select pg_advisory_unlock(hashtextextended($1, 0))", [key]).catch(() => undefined);
      }
    } finally {
      await client.query("select set_config('lock_timeout', '0', false)").catch(() => undefined);
      client.release();
    }
  }

  async ping(): Promise<boolean> {
    const r = await this.pool.query("select 1 as ok");
    return r.rows[0]?.ok === 1;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
