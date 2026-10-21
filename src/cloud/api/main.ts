/**
 * Entrypoint do Render Web Service: `npm run start:api`.
 * Valida TODA a configuração na subida (falha cedo, sem expor valores) e serve /health, /ready
 * e /v1/*. Não executa pipeline: só persiste e enfileira.
 */
import { createServer } from "node:http";
import { loadApiEnv } from "../config";
import { createAuthenticator, createInfra } from "../infra";
import { createLogger } from "../logger";
import { createApiHandler } from "./app";

const logger = createLogger({ service: "api" });

async function main(): Promise<void> {
  const env = loadApiEnv(process.env);
  if (env.persistence !== "supabase") throw new Error("A API cloud exige PERSISTENCE_DRIVER=supabase (o modo local continua sendo `npm run dev`).");
  const infra = createInfra(env, process.env, logger, "api");
  const handler = createApiHandler({ infra, corsOrigins: env.corsOrigins, writesPerMinute: env.writesPerMinute, authenticate: createAuthenticator(env), projectRoot: process.cwd() });
  const server = createServer((req, res) => void handler(req, res));
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.listen(env.port, () => logger.info("api pronta", { port: env.port, origins: env.corsOrigins, assetStore: env.assetStore }));
  const shutdown = (signal: string) => {
    logger.info("encerrando api", { signal });
    server.close(() => void infra.db.close().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error: unknown) => {
  logger.error("api não subiu", { error });
  process.exit(1);
});
