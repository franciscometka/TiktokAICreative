/**
 * Aplica as migrations versionadas (supabase/migrations) no Postgres de DATABASE_URL.
 * Uso: npm run db:migrate   (alternativa: supabase db push, com o Supabase CLI)
 * Nunca imprime a URL do banco.
 */
import { PgSqlClient } from "@/cloud/db/pg-client";
import { migrate } from "@/cloud/db/migrate";

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("DATABASE_URL ausente. Defina no ambiente (nunca commitar).");
  process.exit(1);
}
const db = new PgSqlClient({ connectionString: url, ssl: process.env.DATABASE_SSL !== "disable", max: 1, applicationName: "tiktok-ai-migrate" });
try {
  const applied = await migrate(db);
  console.log(applied.length ? `Migrations aplicadas: ${applied.join(", ")}` : "Banco já está atualizado.");
} catch (error) {
  console.error(`Falha ao migrar: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await db.close();
}
