import { describe, expect, it } from "vitest";
import { migrate } from "./migrate";
import { migratedTestDb, TEST_USER } from "@/test/pglite";

describe("migrations do cloud runtime", () => {
  it("aplicam em Postgres real e são idempotentes", async () => {
    const db = await migratedTestDb();
    expect(await migrate(db)).toEqual([]);
    const tables = (await db.query<{ table_name: string }>("select table_name from information_schema.tables where table_schema = 'public'", [])).rows.map((r) => r.table_name);
    for (const t of ["projects", "campaigns", "jobs", "job_queue", "job_attempts", "avatars", "avatar_revisions", "voice_profiles", "product_assets", "ugc_references", "generated_assets", "render_jobs", "ledger_entries", "change_requests", "job_events", "idempotency_keys", "profiles", "worker_heartbeats"]) {
      expect(tables).toContain(t);
    }
    await db.close();
  });

  it("ledger é append-only no próprio banco (UPDATE/DELETE recusados)", async () => {
    const db = await migratedTestDb();
    await db.query(`insert into ledger_entries (id, user_id, campaign_id, stage, operation, provider, model, confirmed_cost_usd, confirmed_cost_brl, status, entry, created_at)
      values ('c1', $1, 'camp', 'planning', 'campaign_plan', 'anthropic', 'm', 0.1, 0.5, 'confirmed', '{}', now())`, [TEST_USER]);
    await expect(db.query("update ledger_entries set confirmed_cost_brl = 0 where id = 'c1'", [])).rejects.toThrow(/append-only/);
    await expect(db.query("delete from ledger_entries where id = 'c1'", [])).rejects.toThrow(/append-only/);
    await db.close();
  });

  it("constraints recusam status inválido e id inseguro", async () => {
    const db = await migratedTestDb();
    await expect(db.query("insert into campaigns (id, user_id, status, document, created_at, updated_at) values ('../x', $1, 'draft', '{}', now(), now())", [TEST_USER])).rejects.toThrow();
    await expect(db.query("insert into campaigns (id, user_id, status, document, created_at, updated_at) values ('c1', $1, 'weird', '{}', now(), now())", [TEST_USER])).rejects.toThrow();
    await db.close();
  });
});
