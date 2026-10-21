import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SqlClient } from "./sql";

/**
 * Aplica `supabase/migrations/*.sql` em ordem, cada uma numa transação, registrando nome +
 * checksum em `schema_migrations`. Idempotente. Migration já aplicada com conteúdo diferente
 * = erro (nunca editar migration antiga: crie uma nova). Compatível com `supabase db push`
 * (os arquivos seguem o padrão `<timestamp>_<nome>.sql` do Supabase CLI).
 */

export const MIGRATIONS_DIR = resolve(process.cwd(), "supabase", "migrations");
const FILE = /^\d{14}_[a-z0-9_]+\.sql$/;

export class MigrationError extends Error {
  override name = "MigrationError";
}

export async function listMigrations(dir = MIGRATIONS_DIR): Promise<{ name: string; sql: string; checksum: string }[]> {
  const names = (await readdir(dir)).filter((n) => FILE.test(n)).sort();
  return Promise.all(names.map(async (name) => {
    const sql = await readFile(join(dir, name), "utf8");
    return { name, sql, checksum: createHash("sha256").update(sql).digest("hex") };
  }));
}

export async function migrate(db: SqlClient, dir = MIGRATIONS_DIR): Promise<string[]> {
  await db.query(`create table if not exists public.schema_migrations (
    name text primary key, checksum text not null, applied_at timestamptz not null default now())`);
  const applied = new Map((await db.query<{ name: string; checksum: string }>("select name, checksum from public.schema_migrations")).rows.map((r) => [r.name, r.checksum]));
  const done: string[] = [];
  for (const migration of await listMigrations(dir)) {
    const previous = applied.get(migration.name);
    if (previous) {
      if (previous !== migration.checksum) throw new MigrationError(`Migration ${migration.name} já aplicada com outro conteúdo. Crie uma migration nova.`);
      continue;
    }
    await db.transaction(async (tx) => {
      await tx.query(migration.sql);
      await tx.query("insert into public.schema_migrations (name, checksum) values ($1, $2)", [migration.name, migration.checksum]);
    });
    done.push(migration.name);
  }
  return done;
}
