import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiHandler } from "@/cloud/api/app";
import { LocalAssetStore } from "@/cloud/assets/asset-store";
import { AuthError } from "@/cloud/auth/jwt";
import { createLogger, type Logger } from "@/cloud/logger";
import { PostgresJobQueue } from "@/cloud/queue/job-queue";
import type { CloudInfra } from "@/cloud/runtime";
import { CloudWorker } from "@/cloud/worker/worker";
import { loadAppConfig } from "@/config/env";
import { migratedTestDb, OTHER_USER, TEST_USER, type PgliteSqlClient } from "./pglite";

/**
 * Nuvem inteira em memória para testes: Postgres real (PGlite), storage local com URL
 * assinada, API HTTP em 127.0.0.1 (porta aleatória) e worker dirigido por `drain()`.
 * Providers são os MOCKS do pipeline: nenhuma chamada paga, nenhuma rede externa.
 */

export const FAKE_SECRETS = {
  KREA_API_KEY: "krea-secret-value-0123456789",
  ANTHROPIC_API_KEY: "sk-ant-secret-value-0123456789",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-secret-value-0123456789",
  ELEVENLABS_API_KEY: "eleven-secret-value-0123456789",
};

export interface CloudHarness {
  db: PgliteSqlClient;
  infra: CloudInfra;
  base: string;
  logs: string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- corpo JSON livre nos asserts dos testes
  call(method: string, path: string, options?: { user?: "a" | "b" | null; body?: unknown; headers?: Record<string, string> }): Promise<{ status: number; json: any; text: string; headers: Headers }>;
  worker(id?: string, leaseSeconds?: number): CloudWorker;
  drain(worker?: CloudWorker): Promise<number>;
  /** Simula um NOVO processo da API (restart/deploy): mesmo banco, nada em memória. */
  restartApi(): Promise<void>;
  close(): Promise<void>;
}

export async function cloudHarness(options: { writesPerMinute?: number } = {}): Promise<CloudHarness> {
  const db = await migratedTestDb();
  const tmp = await mkdtemp(join(tmpdir(), "cloud-e2e-"));
  const logs: string[] = [];
  const logger: Logger = createLogger({ service: "test", sink: (l) => logs.push(l), secrets: Object.values(FAKE_SECRETS) });
  const env = { ALLOW_MOCKS: "true", ...FAKE_SECRETS };
  let server: Server;
  let base = "";
  const infra: CloudInfra = {
    db, queue: new PostgresJobQueue(db), config: loadAppConfig(env), configIssues: [], env, logger, signedUrlTtlSeconds: 60,
    storage: undefined as never,
  };
  const users: Record<string, string> = { "Bearer user-a": TEST_USER, "Bearer user-b": OTHER_USER };
  const start = async () => {
    const ref: { handler?: ReturnType<typeof createApiHandler> } = {};
    server = createServer((req, res) => void ref.handler!(req, res));
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    infra.storage = new LocalAssetStore(join(tmp, "storage"), "tiktok-media", { secret: "local-signing-secret-xyz", baseUrl: base });
    ref.handler = createApiHandler({
      infra, corsOrigins: ["https://app.vercel.app"], writesPerMinute: options.writesPerMinute ?? 1000,
      authenticate: async (h) => { const u = h ? users[h] : undefined; if (!u) throw new AuthError("Sessão inválida."); return { userId: u }; },
    });
  };
  await start();
  const harness: CloudHarness = {
    db, infra, logs,
    get base() { return base; },
    async call(method, path, o = {}) {
      const headers: Record<string, string> = { ...(o.user === null ? {} : { Authorization: `Bearer user-${o.user ?? "a"}` }), ...(o.body !== undefined ? { "Content-Type": "application/json" } : {}), ...o.headers };
      const response = await fetch(`${base}${path}`, { method, headers, ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}) });
      const text = await response.text();
      let json: unknown;
      try { json = JSON.parse(text); } catch { json = undefined; }
      return { status: response.status, json, text, headers: response.headers };
    },
    worker(id = "worker-1", leaseSeconds = 30) {
      return new CloudWorker({ infra, workerId: id, tmpRoot: join(tmp, "work"), projectRoot: process.cwd(), leaseSeconds, pollIntervalMs: 10, chdir: true, logger });
    },
    async drain(worker = harness.worker()) {
      let n = 0;
      while ((await worker.tick()) === "processed") n++;
      return n;
    },
    async restartApi() {
      await new Promise<void>((ok) => server.close(() => ok()));
      await start();
    },
    async close() {
      await new Promise<void>((ok) => server.close(() => ok()));
      await db.close();
      await rm(tmp, { recursive: true, force: true });
    },
  };
  return harness;
}
