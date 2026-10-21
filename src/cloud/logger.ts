/**
 * Logging estruturado (JSON por linha) da API e do worker. Campos de correlação: requestId,
 * projectId, jobId, attemptId, stage. Tudo passa por `redact` antes de sair:
 * - chaves com cara de segredo (authorization, apikey, token, secret, password, cookie, key) → "[redacted]";
 * - URLs assinadas: query string removida (o token é a parte sensível);
 * - valores de segredos conhecidos do ambiente são substituídos onde aparecerem.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";
export interface LogContext {
  requestId?: string;
  projectId?: string;
  jobId?: string;
  attemptId?: string;
  stage?: string;
  [key: string]: unknown;
}

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  child(context: LogContext): Logger;
}

const SENSITIVE_KEY = /(authorization|api[-_]?key|apikey|token|secret|password|cookie|service[-_]?role|^key$|signature|jwt)/i;
const SIGNED_URL = /(https?:\/\/[^\s"'?]+)\?[^\s"']*/g;
const BEARER = /Bearer\s+[A-Za-z0-9._~+/=-]+/g;

export function redactString(value: string, secrets: readonly string[] = []): string {
  let out = value.replace(BEARER, "Bearer [redacted]").replace(SIGNED_URL, "$1?[redacted]");
  for (const secret of secrets) if (secret.length >= 8) out = out.split(secret).join("[redacted]");
  return out;
}

export function redact(value: unknown, secrets: readonly string[] = [], depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (typeof value === "string") return redactString(value, secrets);
  if (value instanceof Error) return { name: value.name, message: redactString(value.message, secrets) };
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, secrets, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE_KEY.test(k) ? "[redacted]" : redact(v, secrets, depth + 1);
    return out;
  }
  return value;
}

/** Valores de segredo do ambiente (para substituir caso apareçam em mensagens de erro). */
export function knownSecrets(env: Record<string, string | undefined> = process.env): string[] {
  return Object.entries(env)
    .filter(([name, value]) => !!value && /(KEY|SECRET|TOKEN|PASSWORD|DATABASE_URL)/.test(name) && !name.startsWith("NEXT_PUBLIC_"))
    .map(([, value]) => value!.trim())
    .filter((v) => v.length >= 8);
}

export function createLogger(options: { service: string; level?: LogLevel; sink?: (line: string) => void; secrets?: readonly string[]; base?: LogContext } ): Logger {
  const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
  const min = order[options.level ?? "info"];
  const sink = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`));
  const secrets = options.secrets ?? knownSecrets();
  const make = (base: LogContext): Logger => {
    const write = (level: LogLevel, message: string, context?: LogContext) => {
      if (order[level] < min) return;
      const entry = redact({ ts: new Date().toISOString(), level, service: options.service, message, ...base, ...context }, secrets);
      sink(JSON.stringify(entry));
    };
    return {
      debug: (m, c) => write("debug", m, c),
      info: (m, c) => write("info", m, c),
      warn: (m, c) => write("warn", m, c),
      error: (m, c) => write("error", m, c),
      child: (context) => make({ ...base, ...context }),
    };
  };
  return make(options.base ?? {});
}

/** Logger que descarta tudo (testes). */
export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silentLogger };
