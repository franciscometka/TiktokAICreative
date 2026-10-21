import { PGlite, type Transaction } from "@electric-sql/pglite";
import { migrate } from "@/cloud/db/migrate";
import type { QueryResult, SqlClient, SqlExecutor } from "@/cloud/db/sql";
import { KeyedMutex } from "@/lib/keyed-mutex";

/**
 * Postgres REAL em memória (PGlite/WASM) para os testes da nuvem: migrations, constraints,
 * índices parciais, `for update skip locked` e triggers rodam de verdade, sem rede e sem custo.
 * Limitação: uma única sessão — o lock entre processos é emulado por mutex em memória.
 */

type Queryable = Pick<PGlite, "query" | "exec"> | Transaction;

function executor(db: Queryable): SqlExecutor {
  return {
    async query<T>(text: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
      if (params.length === 0) {
        const results = await db.exec(text);
        const last = results[results.length - 1];
        return { rows: (last?.rows ?? []) as T[], rowCount: last?.affectedRows ?? last?.rows.length ?? 0 };
      }
      const r = await db.query<T>(text, params as unknown[]);
      return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
    },
  };
}

export class PgliteSqlClient implements SqlClient {
  private readonly locks = new KeyedMutex();
  private readonly base: SqlExecutor;

  constructor(readonly db: PGlite) {
    this.base = executor(db);
  }

  query<T>(text: string, params?: readonly unknown[]): Promise<QueryResult<T>> {
    return this.base.query<T>(text, params);
  }

  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return this.db.transaction((tx) => fn(executor(tx)));
  }

  withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return this.locks.run(key, fn);
  }

  async ping(): Promise<boolean> {
    return (await this.query<{ ok: number }>("select 1 as ok", [])).rows[0]?.ok === 1;
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

/** Banco novo com todas as migrations aplicadas. */
export async function migratedTestDb(): Promise<PgliteSqlClient> {
  const client = new PgliteSqlClient(new PGlite());
  await migrate(client);
  return client;
}

export const TEST_USER = "11111111-1111-4111-8111-111111111111";
export const OTHER_USER = "22222222-2222-4222-8222-222222222222";
