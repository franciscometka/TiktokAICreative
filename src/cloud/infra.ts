import { resolve } from "node:path";
import { loadAppConfig } from "@/config/env";
import { LocalAssetStore, type AssetStore } from "./assets/asset-store";
import { SupabaseAssetStore } from "./assets/supabase-asset-store";
import { RemoteJwks, bearerToken, verifySupabaseJwt, AuthError, type AuthUser } from "./auth/jwt";
import type { BackendEnv } from "./config";
import { PgSqlClient } from "./db/pg-client";
import type { Logger } from "./logger";
import { PostgresJobQueue } from "./queue/job-queue";
import type { CloudInfra } from "./runtime";

/**
 * Monta a infraestrutura compartilhada (API e worker) a partir do env JÁ validado.
 * Config do pipeline (providers, presets) é validada em modo ESTRITO: inválida = não sobe.
 */
export function createInfra(env: BackendEnv, raw: Record<string, string | undefined>, logger: Logger, service: string): CloudInfra {
  if (!env.databaseUrl) throw new Error("DATABASE_URL ausente");
  const db = new PgSqlClient({ connectionString: env.databaseUrl, max: env.databasePoolMax, ssl: env.databaseSsl, applicationName: `tiktok-ai-${service}` });
  return {
    db,
    storage: createAssetStore(env),
    queue: new PostgresJobQueue(db),
    config: loadAppConfig(raw),
    configIssues: [],
    env: raw,
    logger,
    signedUrlTtlSeconds: env.signedUrlTtlSeconds,
  };
}

export function createAssetStore(env: BackendEnv): AssetStore {
  if (env.assetStore === "local") {
    return new LocalAssetStore(resolve(env.localAssetDir), env.bucket, { secret: env.localAssetSigningSecret!, baseUrl: env.publicApiUrl });
  }
  return new SupabaseAssetStore({ url: env.supabaseUrl!, serviceRoleKey: env.serviceRoleKey!, bucket: env.bucket });
}

/** Sessão: JWT do Supabase Auth. DEV_AUTH_USER_ID só fora de produção (validado no config). */
export function createAuthenticator(env: BackendEnv): (authorization: string | undefined) => Promise<AuthUser> {
  if (env.devAuthUserId && !env.production) {
    const userId = env.devAuthUserId;
    return async () => ({ userId });
  }
  const jwks = new RemoteJwks(`${env.supabaseUrl}/auth/v1/.well-known/jwks.json`);
  return async (authorization) => {
    const token = bearerToken(authorization);
    if (!token) throw new AuthError("Faça login para continuar.");
    return verifySupabaseJwt(token, { supabaseUrl: env.supabaseUrl!, ...(env.jwtSecret ? { jwtSecret: env.jwtSecret } : {}), jwks });
  };
}
