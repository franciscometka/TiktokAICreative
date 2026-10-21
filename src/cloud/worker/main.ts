/**
 * Entrypoint do Render Background Worker: `npm run worker`.
 * `npm run worker:check` só diagnostica (env, banco, storage, Chrome do Remotion, FFmpeg) e sai —
 * sem chamar nenhuma API paga.
 */
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { detectRemotionBrowser } from "@/render/remotion/browser-readiness";
import { ffmpegAvailable } from "@/render/remotion/media-probe";
import { loadWorkerEnv } from "../config";
import { createInfra } from "../infra";
import { createLogger } from "../logger";
import { CloudWorker } from "./worker";

const logger = createLogger({ service: "worker" });

async function main(): Promise<void> {
  const env = loadWorkerEnv(process.env);
  const projectRoot = process.cwd();
  const infra = createInfra(env, process.env, logger, "worker");
  await mkdir(resolve(env.tmpRoot), { recursive: true });

  if (process.argv.includes("--check")) {
    const browser = detectRemotionBrowser(infra.config.renderer.browserExecutable, projectRoot);
    const report = {
      database: await infra.db.ping().catch(() => false),
      storage: await infra.storage.ping().catch(() => false),
      renderer: infra.config.renderer.id,
      browser: browser.available,
      ffmpeg: await ffmpegAvailable(),
      queue: await infra.queue.counts().catch(() => null),
    };
    logger.info("diagnóstico do worker", report);
    await infra.db.close();
    process.exit(report.database && report.storage && (infra.config.renderer.id !== "remotion" || (report.browser && report.ffmpeg)) ? 0 : 1);
  }

  const worker = new CloudWorker({
    infra, projectRoot, workerId: `${hostname()}-${randomUUID().slice(0, 8)}`, tmpRoot: resolve(env.tmpRoot),
    leaseSeconds: env.leaseSeconds, pollIntervalMs: env.pollIntervalMs, staleTmpHours: env.staleTmpHours,
  });
  const shutdown = async (signal: string) => {
    logger.info("encerrando worker (termina a tarefa atual; o lease cobre um kill)", { signal });
    await worker.stop();
    await infra.db.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  // Diagnóstico periódico no log (Render não tem healthcheck para background worker).
  setInterval(() => void infra.queue.counts().then((queue) => logger.info("worker vivo", { queue })).catch((error: unknown) => logger.warn("diagnóstico falhou", { error })), 60_000).unref();
  logger.info("worker pronto", { tmpRoot: env.tmpRoot, leaseSeconds: env.leaseSeconds });
  await worker.run();
}

main().catch((error: unknown) => {
  logger.error("worker não subiu", { error });
  process.exit(1);
});
