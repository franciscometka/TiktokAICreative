/**
 * Modo de execução (Lote 7) — ÚNICA leitura de `NEXT_PUBLIC_RUNTIME_MODE`, usada pelo browser
 * (uploader), pelo servidor Next (session/backend) e pelo `next.config`.
 *
 * Normaliza o valor (espaços, aspas, maiúsculas): "cloud", " cloud\n", "\"cloud\"" e "CLOUD"
 * são todos cloud. Qualquer outra coisa é local. O Next inlina `process.env.NEXT_PUBLIC_*` no
 * BUILD: variável ausente no ambiente daquele build (ex.: definida só em Production e o deploy
 * é Preview) gera um build LOCAL — por isso existe `deployMisconfiguration()`.
 */

export type RuntimeMode = "local" | "cloud";

export function parseRuntimeMode(raw: string | undefined | null): RuntimeMode {
  const value = String(raw ?? "").trim().replace(/^["']+|["']+$/g, "").trim().toLowerCase();
  return value === "cloud" ? "cloud" : "local";
}

/** Valor fixado no build (o browser só enxerga este). */
export const BUILD_RUNTIME_MODE: RuntimeMode = parseRuntimeMode(process.env.NEXT_PUBLIC_RUNTIME_MODE);

export const DEPLOY_MISCONFIGURED_MESSAGE =
  "Este deploy da Vercel foi gerado em modo local, que não funciona na Vercel (sem disco gravável, sem pipeline). Defina NEXT_PUBLIC_RUNTIME_MODE=cloud, NEXT_PUBLIC_API_BASE_URL, NEXT_PUBLIC_SUPABASE_URL e NEXT_PUBLIC_SUPABASE_ANON_KEY para o ambiente DESTE deploy (Production e/ou Preview) e gere um novo build.";

/**
 * Deploy na Vercel (`VERCEL=1`) com modo local = configuração errada: nada deve tentar gravar no
 * filesystem nem rodar o pipeline lá. Devolve a mensagem do problema ou undefined.
 */
export function deployMisconfiguration(env: Record<string, string | undefined> = process.env, mode: RuntimeMode = parseRuntimeMode(process.env.NEXT_PUBLIC_RUNTIME_MODE)): string | undefined {
  return env.VERCEL === "1" && mode === "local" ? DEPLOY_MISCONFIGURED_MESSAGE : undefined;
}

export class DeployMisconfiguredError extends Error {
  override name = "DeployMisconfiguredError";
  constructor(message = DEPLOY_MISCONFIGURED_MESSAGE) {
    super(message);
  }
}
