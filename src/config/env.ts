import { z } from "zod";
import { DEFAULT_VIDEOS_DIR } from "./video-models";
import type { CostBudget, ExchangeRate } from "@/domain/cost";
import { DEFAULT_EXCHANGE_RATE } from "./pricing";
import { GEMINI_UGC_REFERENCE_MODEL, VEO_3_1_MODELS } from "./ugc-models";

/** Defaults de orçamento quando as variáveis de ambiente não estão definidas. */
export const DEFAULT_BUDGET: CostBudget = {
  maxCostPerCreativeBrl: 20,
  maxCostPerCampaignBrl: 100,
  allowOverBudget: false,
};

export const DEFAULT_MAX_ATTEMPTS_PER_SCENE = 3;

/** Imagens enviadas pelo usuário (fora do código-fonte e do git). */
export const DEFAULT_UPLOADS_DIR = "outputs/uploads";
/** Vídeos renderizados: <RENDERS_DIR>/<campaignId>/<creativeId>/v<N>/final.mp4 */
export const DEFAULT_RENDERS_DIR = "outputs/renders";
/** Narrações: <AUDIO_DIR>/<campaignId>/<creativeId>/v<N>/{narration.mp3, timing.json, metadata.json} */
export const DEFAULT_AUDIO_DIR = "outputs/audio";
export const DEFAULT_TTS_TIMEOUT_MS = 60_000;

/** Renderer: "mock" (padrão; não gera arquivo) ou "remotion" (MP4 real, local, sem custo de API). */
export const RENDERER_IDS = ["mock", "remotion"] as const;

/** Política de retry do LLM (ver docs/DECISIONS.md D23). */
export const DEFAULT_LLM_POLICY = {
  /** Tentativas por saída estruturada inválida (1 = sem retry). Máximo 3. */
  maxValidationAttempts: 2,
  /** Retries de transporte do SDK (429/5xx/conexão). Máximo 2. */
  maxTransportRetries: 1,
  timeoutMs: 600_000,
} as const;

/** Providers disponíveis. Vídeo: mock ou Runway; áudio: mock ou ElevenLabs. */
export const LLM_PROVIDER_IDS = ["mock", "anthropic"] as const;
export const VIDEO_PROVIDER_IDS = ["mock", "runway"] as const;
export const AUDIO_PROVIDER_IDS = ["mock", "elevenlabs"] as const;
export const UGC_PROVIDER_IDS = ["mock", "google", "krea"] as const;

const emptyToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const optionalPositiveNumber = z.preprocess(emptyToUndefined, z.coerce.number().positive().optional());

const EnvSchema = z.object({
  LLM_PROVIDER: z.preprocess(emptyToUndefined, z.enum(LLM_PROVIDER_IDS).default("mock")),
  MOCK_PLANNER_DELAY_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).max(120_000).default(0)),
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
  UPLOADS_DIR: z.preprocess(emptyToUndefined, z.string().default(DEFAULT_UPLOADS_DIR)),
  RENDERS_DIR: z.preprocess(emptyToUndefined, z.string().default(DEFAULT_RENDERS_DIR)),
  VIDEOS_DIR: z.preprocess(emptyToUndefined, z.string().default(DEFAULT_VIDEOS_DIR)),
  /** AI UGC (Lote 5.3): referências pessoa + produto versionadas. */
  UGC_DIR: z.preprocess(emptyToUndefined, z.string().default("outputs/ugc")),
  /** Estratégia de áudio do UGCVideoProvider MOCK (o real declara a sua). */
  UGC_MOCK_AUDIO_STRATEGY: z.preprocess(emptyToUndefined, z.enum(["native_speech", "external_lipsync"]).default("native_speech")),
  /** AI UGC REAL (Lote 5.4): provider, opt-in explícito e modelos. A chave fica fora do schema. */
  UGC_PROVIDER: z.preprocess(emptyToUndefined, z.enum(UGC_PROVIDER_IDS).default("mock")),
  UGC_REAL_ALLOWED: z.preprocess(emptyToUndefined, z.enum(["true", "false"]).default("false")),
  UGC_REFERENCE_MODEL: z.preprocess(emptyToUndefined, z.enum([GEMINI_UGC_REFERENCE_MODEL]).default(GEMINI_UGC_REFERENCE_MODEL)),
  UGC_VIDEO_MODEL: z.preprocess(emptyToUndefined, z.enum([VEO_3_1_MODELS.fast, VEO_3_1_MODELS.lite, VEO_3_1_MODELS.standard]).default(VEO_3_1_MODELS.fast)),
  AUDIO_DIR: z.preprocess(emptyToUndefined, z.string().default(DEFAULT_AUDIO_DIR)),
  TTS_TIMEOUT_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().min(5_000).max(300_000).default(DEFAULT_TTS_TIMEOUT_MS)),
  RENDERER: z.preprocess(emptyToUndefined, z.enum(RENDERER_IDS).default("mock")),
  RENDER_CONCURRENCY: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(16).optional()),
  RENDER_DEBUG: z.preprocess(emptyToUndefined, z.enum(["true", "false"]).default("false")),
  RENDER_BROWSER_EXECUTABLE: z.preprocess(emptyToUndefined, z.string().optional()),
  VIDEO_PROVIDER: z.preprocess(emptyToUndefined, z.enum(VIDEO_PROVIDER_IDS).default("mock")),
  AUDIO_PROVIDER: z.preprocess(emptyToUndefined, z.enum(AUDIO_PROVIDER_IDS).default("mock")),
  USD_BRL_EXCHANGE_RATE: optionalPositiveNumber,
  MAX_COST_PER_CREATIVE_BRL: optionalPositiveNumber,
  MAX_COST_PER_CAMPAIGN_BRL: optionalPositiveNumber,
  ALLOW_OVER_BUDGET: z.preprocess(emptyToUndefined, z.enum(["true", "false"]).default("false")),
  /** Lote 5.5: MOCK só com opt-in explícito (dev/teste). Padrão false = fluxo normal REAL-only. */
  ALLOW_MOCKS: z.preprocess(emptyToUndefined, z.enum(["true", "false"]).default("false")),
  MAX_ATTEMPTS_PER_SCENE: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(1).max(10).default(DEFAULT_MAX_ATTEMPTS_PER_SCENE),
  ),
});

export interface ConfigIssue {
  variable: string;
  message: string;
}

/** Configuração NÃO secreta. A API key nunca entra aqui (ver readAnthropicApiKey). */
export interface AppConfig {
  llmProvider: (typeof LLM_PROVIDER_IDS)[number];
  /** Só para LLM_PROVIDER=mock: atraso artificial para exercitar a tela de processamento. */
  mockPlannerDelayMs: number;
  llmPolicy: { maxValidationAttempts: number; maxTransportRetries: number; timeoutMs: number };
  storage: "file" | "memory";
  dataDir: string;
  uploadsDir: string;
  rendersDir: string;
  audioDir: string;
  videosDir: string;
  ugcDir: string;
  ugcMockAudioStrategy: "native_speech" | "external_lipsync";
  /** AI UGC REAL: só habilita com provider google + UGC_REAL_ALLOWED=true + chave no servidor. */
  ugc: { provider: (typeof UGC_PROVIDER_IDS)[number]; realAllowed: boolean; referenceModel: string; videoModel: string };
  /** Timeout de UMA chamada de TTS (sem retry automático). */
  ttsTimeoutMs: number;
  renderer: {
    id: (typeof RENDERER_IDS)[number];
    concurrency: number | null;
    debug: boolean;
    /** Chrome/Chrome Headless Shell alternativo (ex.: quando o caminho do projeto é longo demais no Windows). */
    browserExecutable: string | null;
  };
  videoProvider: (typeof VIDEO_PROVIDER_IDS)[number];
  audioProvider: (typeof AUDIO_PROVIDER_IDS)[number];
  exchangeRate: ExchangeRate;
  defaultBudget: CostBudget;
  maxAttemptsPerScene: number;
  /** false (padrão): nenhuma etapa do fluxo normal pode produzir resultado MOCK. */
  allowMocks: boolean;
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
    mockPlannerDelayMs: e.MOCK_PLANNER_DELAY_MS,
    llmPolicy: {
      maxValidationAttempts: e.LLM_MAX_VALIDATION_ATTEMPTS,
      maxTransportRetries: e.LLM_MAX_TRANSPORT_RETRIES,
      timeoutMs: e.LLM_TIMEOUT_MS,
    },
    storage: e.STORAGE,
    dataDir: e.DATA_DIR,
    uploadsDir: e.UPLOADS_DIR,
    rendersDir: e.RENDERS_DIR,
    audioDir: e.AUDIO_DIR,
    videosDir: e.VIDEOS_DIR,
    ugcDir: e.UGC_DIR,
    ugcMockAudioStrategy: e.UGC_MOCK_AUDIO_STRATEGY,
    ugc: { provider: e.UGC_PROVIDER, realAllowed: e.UGC_REAL_ALLOWED === "true", referenceModel: e.UGC_REFERENCE_MODEL, videoModel: e.UGC_VIDEO_MODEL },
    ttsTimeoutMs: e.TTS_TIMEOUT_MS,
    renderer: {
      id: e.RENDERER,
      concurrency: e.RENDER_CONCURRENCY ?? null,
      debug: e.RENDER_DEBUG === "true",
      browserExecutable: e.RENDER_BROWSER_EXECUTABLE ?? null,
    },
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
    allowMocks: e.ALLOW_MOCKS === "true",
  };
}

const CONFIG_HINTS: Record<string, string> = {
  LLM_PROVIDER: 'Use "mock" ou "anthropic".',
  VIDEO_PROVIDER: 'Use "mock" ou "runway" (não use RUNWAYML).',
  AUDIO_PROVIDER: 'Use "mock" ou "elevenlabs".',
  RENDERER: 'Use "mock" ou "remotion".',
  UGC_PROVIDER: 'Use "mock", "google" ou "krea".',
  ALLOW_MOCKS: 'Use "true" (só dev/teste) ou "false" (padrão).',
  UGC_REAL_ALLOWED: 'Use "true" ou "false" (padrão false).',
};

/**
 * Mantém a interface acessível quando uma variável está inválida, mas nunca habilita
 * um provider por aproximação: o campo inválido volta ao default seguro (MOCK) e a
 * falha é devolvida para o diagnóstico público. Segredos não fazem parte do schema.
 */
export function loadAppConfigSafe(
  env: Record<string, string | undefined> = process.env,
  now: () => string = () => new Date().toISOString(),
): { config: AppConfig; issues: ConfigIssue[] } {
  const parsed = EnvSchema.safeParse(env);
  if (parsed.success) return { config: loadAppConfig(env, now), issues: [] };

  const sanitized = { ...env };
  const invalidVariables = new Set<string>();
  for (const issue of parsed.error.issues) {
    const variable = String(issue.path[0] ?? "CONFIG");
    invalidVariables.add(variable);
    if (variable !== "CONFIG") sanitized[variable] = undefined;
  }
  const issues = [...invalidVariables].map((variable) => ({
    variable,
    message: `${variable} tem um valor inválido. ${CONFIG_HINTS[variable] ?? "Revise o valor em .env.local."} Enquanto isso, o runtime usa o padrão seguro.`,
  }));

  const fallback = EnvSchema.safeParse(sanitized);
  if (!fallback.success) {
    return {
      config: loadAppConfig({}, now),
      issues: [{ variable: "CONFIG", message: "A configuração local não pôde ser validada. O runtime foi aberto integralmente em MOCK; revise .env.local." }],
    };
  }
  return { config: loadAppConfig(sanitized, now), issues };
}

/**
 * Lê a API key da Anthropic SOMENTE do ambiente. Chamado apenas pela fábrica do cliente LLM
 * (código de servidor). Nunca logar, nunca serializar, nunca enviar ao browser.
 */
export function readAnthropicApiKey(env: Record<string, string | undefined> = process.env): string | undefined {
  const key = env.ANTHROPIC_API_KEY?.trim();
  return key ? key : undefined;
}

/**
 * Chave de licença do Remotion (Company License), lida SOMENTE do ambiente pela fábrica do
 * renderer. Ausente = nenhuma telemetria de licença é enviada. Nunca logar nem enviar ao browser.
 */
/**
 * Lê a API key da ElevenLabs SOMENTE do ambiente, pela fábrica do provider de áudio (servidor).
 * Nunca logar, nunca serializar, nunca enviar ao browser.
 */
export function readElevenLabsApiKey(env: Record<string, string | undefined> = process.env): string | undefined {
  const key = env.ELEVENLABS_API_KEY?.trim();
  return key ? key : undefined;
}

export function readRemotionLicenseKey(env: Record<string, string | undefined> = process.env): string | null {
  const key = env.REMOTION_LICENSE_KEY?.trim();
  return key ? key : null;
}

/** Segredo lido só no servidor; nunca entra em AppConfig. */
export function readRunwayApiKey(env: Record<string, string | undefined> = process.env): string | undefined {
  return env.RUNWAYML_API_SECRET?.trim() || undefined;
}

/** Chave da Krea API (AI UGC via Krea). Só servidor; nunca entra em AppConfig, logs, erros ou UI. */
export function readKreaApiKey(env: Record<string, string | undefined> = process.env): string | undefined {
  return env.KREA_API_KEY?.trim() || undefined;
}

/** Chave da Gemini API (Google AI). Só servidor; nunca entra em AppConfig, logs, erros ou UI. */
export function readGoogleAiApiKey(env: Record<string, string | undefined> = process.env): string | undefined {
  return env.GOOGLE_AI_API_KEY?.trim() || undefined;
}
