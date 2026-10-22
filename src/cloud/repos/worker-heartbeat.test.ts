import { hostname } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workerStatusFrom, WORKER_OFFLINE_AFTER_MS } from "@/application/worker-status";
import { createLogger } from "@/cloud/logger";
import { cloudHarness, type CloudHarness } from "@/test/cloud-harness";
import { startHeartbeat, WorkerHeartbeatRepository, workerKey } from "./worker-heartbeat-repository";

/** L8.1 — presença do worker: tabela isolada, API só com estado + último contato. */

let h: CloudHarness;
beforeAll(async () => { h = await cloudHarness(); });
afterAll(async () => { await h.close(); });

describe("worker_heartbeats", () => {
  it("sem nenhum heartbeat: API responde 'unknown' (não 'offline'); exige sessão", async () => {
    expect((await h.call("GET", "/v1/worker", { user: null })).status).toBe(401);
    const res = await h.call("GET", "/v1/worker");
    expect(res.status).toBe(200);
    expect(res.json.value).toEqual({ state: "unknown", lastSeenAt: null });
  });

  it("heartbeat é criado e depois atualizado (uma linha por worker)", async () => {
    const repo = new WorkerHeartbeatRepository(h.db);
    const key = workerKey("host-a-1234");
    await repo.beat(key, new Date("2026-10-22T10:00:00Z"));
    await repo.beat(key, new Date("2026-10-22T10:00:30Z"));
    const rows = (await h.db.query<{ worker_key: string; heartbeat_at: Date }>("select worker_key, heartbeat_at from worker_heartbeats where worker_key = $1", [key])).rows;
    expect(rows).toHaveLength(1);
    expect(new Date(rows[0]!.heartbeat_at).toISOString()).toBe("2026-10-22T10:00:30.000Z");
    expect(await repo.latest()).toBe("2026-10-22T10:00:30.000Z");
  });

  it("recente = online; velho além do limite = offline", () => {
    const now = new Date("2026-10-22T10:05:00Z");
    expect(workerStatusFrom(new Date(now.getTime() - 30_000), now).state).toBe("online");
    expect(workerStatusFrom(new Date(now.getTime() - WORKER_OFFLINE_AFTER_MS), now).state).toBe("online");
    expect(workerStatusFrom(new Date(now.getTime() - WORKER_OFFLINE_AFTER_MS - 1000), now).state).toBe("offline");
  });

  it("API com heartbeat recente: online, e o corpo só tem estado + último contato", async () => {
    await new WorkerHeartbeatRepository(h.db).beat(workerKey(`${hostname()}-abcd1234`));
    const res = await h.call("GET", "/v1/worker");
    expect(res.json.value.state).toBe("online");
    expect(Object.keys(res.json.value).sort()).toEqual(["lastSeenAt", "state"]);
    // Nada do processo: sem hostname, id, path ou env.
    expect(res.text).not.toContain(hostname());
    expect(res.text).not.toMatch(/worker_key|workerId|[A-Z]:\\|\/tmp|DATABASE_URL|secret/i);
  });

  it("a chave gravada é um hash opaco (nunca o hostname)", async () => {
    const key = workerKey(`${hostname()}-deadbeef`);
    expect(key).toMatch(/^[a-f0-9]{32}$/);
    expect(key).not.toContain(hostname().toLowerCase());
    const stored = (await h.db.query<{ worker_key: string }>("select worker_key from worker_heartbeats", [])).rows.map((r) => r.worker_key);
    for (const k of stored) expect(k).toMatch(/^[a-f0-9]{16,64}$/);
  });

  it("banco recusa chave fora do formato (ex.: hostname em claro)", async () => {
    await expect(new WorkerHeartbeatRepository(h.db).beat("MEU-PC.local")).rejects.toThrow();
  });

  it("heartbeat que falha não lança, loga UMA vez e volta sozinho; o worker continua processando", async () => {
    const lines: string[] = [];
    const logger = createLogger({ service: "test", sink: (l) => lines.push(l) });
    let fail = true;
    const repo = { beat: async () => { if (fail) throw new Error("connection terminated"); } };
    const hb = startHeartbeat({ repo, key: workerKey("x"), logger, intervalMs: 60_000 });
    try {
      expect(await hb.beatNow()).toBe(false);
      expect(await hb.beatNow()).toBe(false);
      expect(lines.filter((l) => l.includes("heartbeat do worker falhou"))).toHaveLength(1);
      // Fila e processamento não dependem do heartbeat: o worker drena normalmente.
      expect(await h.drain()).toBeGreaterThanOrEqual(0);
      fail = false;
      expect(await hb.beatNow()).toBe(true);
      expect(lines.some((l) => l.includes("heartbeat do worker voltou"))).toBe(true);
    } finally {
      hb.stop();
    }
  });
});
