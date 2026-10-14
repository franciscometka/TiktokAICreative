import { z } from "zod";
import type { CostBudget, ExchangeRate } from "@/domain/cost";
import { DEFAULT_EXCHANGE_RATE } from "./pricing";

/** Defaults de orçamento quando as variáveis de ambiente não estão definidas. */
export const DEFAULT_BUDGET: CostBudget = {
  maxCostPerCreativeBrl: 20,
  maxCostPerCampaignBrl: 100,
  allowOverBudget: false,
};

export const DEFAULT_MAX_ATTEMPTS_PER_SCENE = 3;

/** Política de retry do LLM (ver docs/DECISIONS.md D23). */
export const DEFAULT_LLM_POLICY = {
  /** Tentativas por saída estruturada inválida (1 = sem retry). Máximo 3. */
  maxValidationAttempts: 2,
  /** Retries de transporte do SDK (429/5xx/conexão). Máximo 2. */
  maxTransportRetries: 1,
  timeoutMs: 600_000,
} as const;

/** Providers disponíveis. Vídeo/áudio só têm mock nesta fase. */
export const LLM_PROVIDER_IDS = ["mock", "anthropic"] as const;
export const VIDEO_PROVIDER_IDS = ["mock"] as const;
export const AUDIO_PROVIDER_IDS = ["mock"] as const;

const emptyToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const optionalPositiveNumber = z.preprocess(emptyToUndefined, z.coerce.number().positive().optional());

const EnvSchema = z.object({
  LLM_PROVIDER: z.preprocess(emptyToUndefined, z.enum(LLM_PROVIDER_IDS).default("mock")),
  LLM_MAX_VALIDATION_ATTEMPTS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(1).max(3).default(DEFAULT_LLM_POLICY.maxValidationAttempts),
  ),
  LLM_MAX_TRANSPORT_RETRIES: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(0).max(2).default(DEFAULT_LLM_POLICY.maxTransportRetries),
  ),
  LLM_TIMEOUT_MS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(10_000).max(1_800_000).default(DEFAULT_LLM_POLICY.timeoutMs),
  ),
  STORAGE: z.preprocess(emptyToUndefined, z.enum(["file", "memory"]).default("file")),
  DATA_DIR: z.preprocess(emptyToUndefined, z.string().default("data")),
  VIDEO_PROVIDER: z.preprocess(emptyToUndefined, z.enum(VIDEO_PROVIDER_IDS).default("mock")),
  AUDIO_PROVIDER: z.preprocess(emptyToUndefined, z.enum(AUDIO_PROVIDER_IDS).default("mock")),
  USD_BRL_EXCHANGE_RATE: optionalPositiveNumber,
  MAX_COST_PER_CREATIVE_BRL: optionalPositiveNumber,
  MAX_COST_PER_CAMPAIGN_BRL: optionalPositiveNumber,
  ALLOW_OVER_BUDGET: z.preprocess(emptyToUndefined, z.enum(["true", "false"]).default("false")),
  MAX_ATTEMPTS_PER_SCENE: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(1).max(10).default(DEFAULT_MAX_ATTEMPTS_PER_SCENE),
  ),
});

/** Configuração NÃO secreta. A API key nunca entra aqui (ver readAnthropicApiKey). */
export interface AppConfig {
  llmProvider: (typeof LLM_PROVIDER_IDS)[number];
  llmPolicy: { maxValidationAttempts: number; maxTransportRetries: number; timeoutMs: number };
  storage: "file" | "memory";
  dataDir: string;
  videoProvider: (typeof VIDEO_PROVIDER_IDS)[number];
  audioProvider: (typeof AUDIO_PROVIDER_IDS)[number];
  exchangeRate: ExchangeRate;
  defaultBudget: CostBudget;
  maxAttemptsPerScene: number;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** Valida variáveis de ambiente. Falha cedo com mensagem clara em vez de usar valores inválidos. */
export function loadAppConfig(
  env: Record<string, string | undefined> = process.env,
  now: () => string = () => new Date().toISOString(),
): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(`Configuração inválida:\n${z.prettifyError(parsed.error)}`);
  }
  const e = parsed.data;
  return {
    llmProvider: e.LLM_PROVIDER,
    llmPolicy: {
      maxValidationAttempts: e.LLM_MAX_VALIDATION_ATTEMPTS,
      maxTransportRetries: e.LLM_MAX_TRANSPORT_RETRIES,
      timeoutMs: e.LLM_TIMEOUT_MS,
    },
    storage: e.STORAGE,
    dataDir: e.DATA_DIR,
    videoProvider: e.VIDEO_PROVIDER,
    audioProvider: e.AUDIO_PROVIDER,
    exchangeRate:
      e.USD_BRL_EXCHANGE_RATE === undefined
        ? DEFAULT_EXCHANGE_RATE
        : { base: "USD", quote: "BRL", rate: e.USD_BRL_EXCHANGE_RATE, source: "env", updatedAt: now() },
    defaultBudget: {
      maxCostPerCreativeBrl: e.MAX_COST_PER_CREATIVE_BRL ?? DEFAULT_BUDGET.maxCostPerCreativeBrl,
      maxCostPerCampaignBrl: e.MAX_COST_PER_CAMPAIGN_BRL ?? DEFAULT_BUDGET.maxCostPerCampaignBrl,
      allowOverBudget: e.ALLOW_OVER_BUDGET === "true",
    },
    maxAttemptsPerScene: e.MAX_ATTEMPTS_PER_SCENE,
  };
}

/**
 * Lê a API key da Anthropic SOMENTE do ambiente. Chamado apenas pela fábrica do cliente LLM
 * (código de servidor). Nunca logar, nunca serializar, nunca enviar ao browser.
 */
export function readAnthropicApiKey(env: Record<string, string | undefined> = process.env): string | undefined {
  const key = env.ANTHROPIC_API_KEY?.trim();
  return key ? key : undefined;
}
