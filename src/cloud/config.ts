import { z } from "zod";

/**
 * Lote 7 (Cloud Runtime): configuração SEPARADA por serviço, validada no startup.
 *
 * - Frontend (Vercel): só variáveis públicas (`NEXT_PUBLIC_*`) + o modo de runtime. Nunca recebe
 *   segredo de provider, service role nem DATABASE_URL.
 * - Backend API (Render Web Service) e Worker (Render Background Worker): segredos ficam aqui.
 *
 * Erro de configuração derruba o processo NA SUBIDA (ConfigError com os NOMES das variáveis,
 * nunca os valores). Não esperamos uma geração para descobrir que falta algo.
 */

export class CloudConfigError extends Error {
  override name = "CloudConfigError";
}

const emptyToUndefined = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value);
const optional = (schema: z.ZodType) => z.preprocess(emptyToUndefined, schema.optional());
const httpsUrl = z.string().url().refine((u) => /^https?:\/\//.test(u), "precisa ser http(s)");

export const PERSISTENCE_DRIVERS = ["local", "supabase"] as const;
export type PersistenceDriver = (typeof PERSISTENCE_DRIVERS)[number];

/** Nomes que NUNCA podem existir com prefixo público (o Next embute NEXT_PUBLIC_* no bundle). */
const SECRET_NAME = /(SECRET|SERVICE_ROLE|PASSWORD|PRIVATE|DATABASE_URL|API_KEY|_TOKEN)/i;
/** Exceção: a anon key do Supabase é pública por desenho (protegida por RLS). */
const PUBLIC_ALLOWED = new Set(["NEXT_PUBLIC_SUPABASE_ANON_KEY"]);
/** Segredos conhecidos do servidor: o valor de nenhum deles pode aparecer numa variável pública. */
export const SERVER_SECRET_VARIABLES = [
  "ANTHROPIC_API_KEY", "KREA_API_KEY", "ELEVENLABS_API_KEY", "RUNWAYML_API_SECRET", "GOOGLE_AI_API_KEY",
  "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_JWT_SECRET", "DATABASE_URL", "REMOTION_LICENSE_KEY",
] as const;

/**
 * Recusa qualquer `NEXT_PUBLIC_*` com cara de segredo ou com o MESMO valor de um segredo do
 * servidor. Roda no frontend, na API e no worker (defesa em profundidade).
 */
export function assertNoPublicSecrets(env: Record<string, string | undefined>): void {
  const problems: string[] = [];
  const secretValues = new Set(SERVER_SECRET_VARIABLES.map((name) => env[name]?.trim()).filter((v): v is string => !!v && v.length >= 8));
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith("NEXT_PUBLIC_")) continue;
    if (!PUBLIC_ALLOWED.has(name) && SECRET_NAME.test(name)) problems.push(`${name} parece um segredo e não pode ter prefixo NEXT_PUBLIC_`);
    if (value && secretValues.has(value.trim())) problems.push(`${name} tem o valor de um segredo do servidor`);
  }
  if (problems.length) throw new CloudConfigError(`Configuração insegura:\n- ${problems.join("\n- ")}`);
}

function parse<T extends z.ZodType>(schema: T, env: Record<string, string | undefined>, service: string): z.infer<T> {
  const result = schema.safeParse(env);
  if (!result.success) {
    // Só nomes e o tipo do problema; valores nunca entram na mensagem.
    const lines = result.error.issues.map((issue) => `${String(issue.path[0] ?? "CONFIG")}: ${issue.message}`);
    throw new CloudConfigError(`Configuração inválida (${service}):\n- ${[...new Set(lines)].join("\n- ")}`);
  }
  return result.data;
}

// ---------------------------------------------------------------- frontend (Vercel)

const FrontendEnvSchema = z.object({
  /** "local" = Next executa o runtime no próprio processo (dev). "cloud" = tudo via Render API. */
  NEXT_PUBLIC_RUNTIME_MODE: z.preprocess(emptyToUndefined, z.enum(["local", "cloud"]).default("local")),
  NEXT_PUBLIC_API_BASE_URL: optional(httpsUrl),
  NEXT_PUBLIC_SUPABASE_URL: optional(httpsUrl),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: optional(z.string().min(20)),
}).superRefine((env, ctx) => {
  if (env.NEXT_PUBLIC_RUNTIME_MODE !== "cloud") return;
  for (const name of ["NEXT_PUBLIC_API_BASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"] as const) {
    if (!env[name]) ctx.addIssue({ code: "custom", path: [name], message: "obrigatória com NEXT_PUBLIC_RUNTIME_MODE=cloud" });
  }
});

export interface FrontendEnv {
  mode: "local" | "cloud";
  apiBaseUrl?: string;
  supabaseUrl?: string;
  supabaseAnonKey?: string;
}

export function loadFrontendEnv(env: Record<string, string | undefined> = process.env): FrontendEnv {
  assertNoPublicSecrets(env);
  const e = parse(FrontendEnvSchema, env, "frontend");
  return {
    mode: e.NEXT_PUBLIC_RUNTIME_MODE,
    ...(e.NEXT_PUBLIC_API_BASE_URL ? { apiBaseUrl: String(e.NEXT_PUBLIC_API_BASE_URL).replace(/\/+$/, "") } : {}),
    ...(e.NEXT_PUBLIC_SUPABASE_URL ? { supabaseUrl: String(e.NEXT_PUBLIC_SUPABASE_URL).replace(/\/+$/, "") } : {}),
    ...(e.NEXT_PUBLIC_SUPABASE_ANON_KEY ? { supabaseAnonKey: String(e.NEXT_PUBLIC_SUPABASE_ANON_KEY) } : {}),
  };
}

// ---------------------------------------------------------------- backend (API + worker)

const BaseBackendSchema = z.object({
  PERSISTENCE_DRIVER: z.preprocess(emptyToUndefined, z.enum(PERSISTENCE_DRIVERS).default("local")),
  DATABASE_URL: optional(z.string().regex(/^postgres(ql)?:\/\//, "precisa ser uma URL postgres://")),
  DATABASE_POOL_MAX: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(50).default(5)),
  /** "require" (padrão em cloud) exige TLS até o Postgres do Supabase. */
  DATABASE_SSL: z.preprocess(emptyToUndefined, z.enum(["require", "disable"]).default("require")),
  SUPABASE_URL: optional(httpsUrl),
  SUPABASE_SERVICE_ROLE_KEY: optional(z.string().min(20)),
  /** JWT secret legado (HS256). Projetos novos usam chaves assimétricas (JWKS): deixe vazio. */
  SUPABASE_JWT_SECRET: optional(z.string().min(32)),
  SUPABASE_STORAGE_BUCKET: z.preprocess(emptyToUndefined, z.string().regex(/^[a-z0-9][a-z0-9-]{2,62}$/).default("tiktok-media")),
  /** Validade das URLs assinadas (segundos). Curta por padrão: 10 min. */
  SIGNED_URL_TTL_SECONDS: z.preprocess(emptyToUndefined, z.coerce.number().int().min(30).max(3600).default(600)),
  /** Modo local de desenvolvimento sem Supabase Auth: um usuário fixo (NUNCA em produção). */
  DEV_AUTH_USER_ID: optional(z.string().uuid()),
  NODE_ENV: z.preprocess(emptyToUndefined, z.string().default("development")),
});

function requireSupabase(env: z.infer<typeof BaseBackendSchema>, ctx: z.RefinementCtx): void {
  if (env.PERSISTENCE_DRIVER !== "supabase") return;
  for (const name of ["DATABASE_URL", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"] as const) {
    if (!env[name]) ctx.addIssue({ code: "custom", path: [name], message: "obrigatória com PERSISTENCE_DRIVER=supabase" });
  }
  if (env.NODE_ENV === "production" && env.DEV_AUTH_USER_ID) {
    ctx.addIssue({ code: "custom", path: ["DEV_AUTH_USER_ID"], message: "proibida em produção" });
  }
}

const ApiEnvSchema = BaseBackendSchema.extend({
  PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(65535).default(4000)),
  /** Origens permitidas (CSV). Produção: domínio Vercel. Nunca "*". */
  CORS_ALLOWED_ORIGINS: z.preprocess(emptyToUndefined, z.string().default("http://localhost:3000")),
  /** Proteção básica: requisições de escrita por usuário por minuto. */
  RATE_LIMIT_WRITES_PER_MINUTE: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(600).default(30)),
}).superRefine((env, ctx) => {
  requireSupabase(env, ctx);
  const origins = env.CORS_ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean);
  if (origins.includes("*")) ctx.addIssue({ code: "custom", path: ["CORS_ALLOWED_ORIGINS"], message: "\"*\" não é permitido (rotas autenticadas)" });
  for (const origin of origins) if (!/^https?:\/\/[^/]+$/.test(origin)) ctx.addIssue({ code: "custom", path: ["CORS_ALLOWED_ORIGINS"], message: "use origens completas sem caminho (https://app.vercel.app)" });
});

const WorkerEnvSchema = BaseBackendSchema.extend({
  /** Raiz do disco TEMPORÁRIO do worker. Nada aqui é fonte de verdade. */
  WORKER_TMP_ROOT: z.preprocess(emptyToUndefined, z.string().default("/tmp/tiktok-ai")),
  WORKER_POLL_INTERVAL_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().min(200).max(60_000).default(2_000)),
  /** Lease do claim; o heartbeat renova. Worker que morre libera o job quando o lease expira. */
  WORKER_LEASE_SECONDS: z.preprocess(emptyToUndefined, z.coerce.number().int().min(30).max(3600).default(120)),
  /** Arquivos temporários abandonados mais velhos que isso são apagados na subida. */
  WORKER_STALE_TMP_HOURS: z.preprocess(emptyToUndefined, z.coerce.number().min(1).max(720).default(12)),
}).superRefine((env, ctx) => {
  requireSupabase(env, ctx);
  if (env.PERSISTENCE_DRIVER !== "supabase") ctx.addIssue({ code: "custom", path: ["PERSISTENCE_DRIVER"], message: "o worker consome a fila do Postgres: use supabase" });
});

export interface BackendEnv {
  persistence: PersistenceDriver;
  databaseUrl?: string;
  databasePoolMax: number;
  databaseSsl: boolean;
  supabaseUrl?: string;
  /** Lida do ambiente; nunca logada, serializada nem enviada a cliente. */
  serviceRoleKey?: string;
  jwtSecret?: string;
  bucket: string;
  signedUrlTtlSeconds: number;
  devAuthUserId?: string;
  production: boolean;
}

export interface ApiEnv extends BackendEnv {
  port: number;
  corsOrigins: string[];
  writesPerMinute: number;
}

export interface WorkerEnv extends BackendEnv {
  tmpRoot: string;
  pollIntervalMs: number;
  leaseSeconds: number;
  staleTmpHours: number;
}

function backend(e: z.infer<typeof BaseBackendSchema>): BackendEnv {
  return {
    persistence: e.PERSISTENCE_DRIVER,
    ...(e.DATABASE_URL ? { databaseUrl: String(e.DATABASE_URL) } : {}),
    databasePoolMax: e.DATABASE_POOL_MAX,
    databaseSsl: e.DATABASE_SSL === "require",
    ...(e.SUPABASE_URL ? { supabaseUrl: String(e.SUPABASE_URL).replace(/\/+$/, "") } : {}),
    ...(e.SUPABASE_SERVICE_ROLE_KEY ? { serviceRoleKey: String(e.SUPABASE_SERVICE_ROLE_KEY) } : {}),
    ...(e.SUPABASE_JWT_SECRET ? { jwtSecret: String(e.SUPABASE_JWT_SECRET) } : {}),
    bucket: e.SUPABASE_STORAGE_BUCKET,
    signedUrlTtlSeconds: e.SIGNED_URL_TTL_SECONDS,
    ...(e.DEV_AUTH_USER_ID ? { devAuthUserId: String(e.DEV_AUTH_USER_ID) } : {}),
    production: e.NODE_ENV === "production",
  };
}

export function loadApiEnv(env: Record<string, string | undefined> = process.env): ApiEnv {
  assertNoPublicSecrets(env);
  const e = parse(ApiEnvSchema, env, "api");
  return {
    ...backend(e),
    port: e.PORT,
    corsOrigins: e.CORS_ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean),
    writesPerMinute: e.RATE_LIMIT_WRITES_PER_MINUTE,
  };
}

export function loadWorkerEnv(env: Record<string, string | undefined> = process.env): WorkerEnv {
  assertNoPublicSecrets(env);
  const e = parse(WorkerEnvSchema, env, "worker");
  return {
    ...backend(e),
    tmpRoot: e.WORKER_TMP_ROOT,
    pollIntervalMs: e.WORKER_POLL_INTERVAL_MS,
    leaseSeconds: e.WORKER_LEASE_SECONDS,
    staleTmpHours: e.WORKER_STALE_TMP_HOURS,
  };
}
