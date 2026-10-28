/**
 * Acesso a SQL atrás de uma interface mínima. Produção: `PgSqlClient` (node-postgres, Supabase
 * Postgres). Testes: PGlite (Postgres real em WASM, sem rede) em `src/test/pglite.ts`.
 * Nenhum repositório conhece o driver.
 */

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface SqlExecutor {
  query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<QueryResult<T>>;
}

export interface SqlClient extends SqlExecutor {
  /** BEGIN … COMMIT; ROLLBACK em erro. `fn` recebe a conexão da transação. */
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  /**
   * Exclusão mútua ENTRE PROCESSOS por chave (API × worker na mesma campanha).
   * Implementado com advisory lock do Postgres numa conexão dedicada.
   */
  withLock<T>(key: string, fn: () => Promise<T>, options?: { timeoutMs?: number }): Promise<T>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

/** O lock não foi obtido no prazo: outra operação (provavelmente o worker) está nesta campanha. */
export class LockTimeoutError extends Error {
  override name = "JobInProgressError";
}

/** Violação de unicidade (23505) — usada para dedupe de fila e idempotência. */
export function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "23505";
}

export function isLockNotAvailable(error: unknown): boolean {
  const code = typeof error === "object" && error !== null ? (error as { code?: string }).code : undefined;
  return code === "55P03" || code === "57014";
}
