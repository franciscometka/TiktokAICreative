import { createHybridPipelineService, hybridCapabilities } from "@/pipeline/hybrid-service";
import type { StageCapabilities } from "@/domain/execution";
import type { AppDeps } from "@/application/campaign-actions";
import { loadAppConfigSafe, type AppConfig, type ConfigIssue } from "@/config/env";
import { runtimeReadiness } from "@/config/readiness";
import { mocksAllowed } from "@/config/execution-policy";
import type { RuntimeReadiness } from "@/domain/readiness";
import { RUNWAY_VIDEO } from "@/config/video-models";
import { PRICING_TABLE } from "@/config/pricing";
import { summarizePresets, type PresetSummary } from "@/costs/preset-summary";
import { StaticPricingCatalog } from "@/costs/pricing-catalog";
import type { CostBudget } from "@/domain/cost";
import { LocalUploadStore } from "@/storage/upload-store";
import { SIMPLE_QUALITY_PRESETS } from "@/config/simple-presets";
import { FileAvatarLibraryStore } from "@/storage/avatar-store";
import { v2Estimates, type V2EstimateView } from "@/application/create-v2";
import { kreaUgcPricingRefs } from "@/config/krea-ugc-models";

/**
 * Runtime do processo Next.js (SERVIDOR). Um único PipelineService por processo: ele guarda os
 * locks por campanha e os planejamentos em execução. Guardado em globalThis para sobreviver ao
 * hot reload do `next dev` (senão um planejamento em andamento pareceria interrompido).
 *
 * Só importar a partir de Server Components, Server Actions e route handlers.
 */

interface Runtime {
  config: AppConfig;
  configIssues: ConfigIssue[];
  deps: AppDeps;
}

const KEY = Symbol.for("tiktok-ai-creative-factory.runtime");
type GlobalWithRuntime = typeof globalThis & { [KEY]?: Runtime };

export function getRuntime(): Runtime {
  const g = globalThis as GlobalWithRuntime;
  if (!g[KEY]) {
    const { config, issues: configIssues } = loadAppConfigSafe();
    g[KEY] = {
      config,
      configIssues,
      deps: {
        service: createHybridPipelineService(config, {}, process.env, configIssues),
        uploads: new LocalUploadStore(config.uploadsDir),
        rendersDir: config.rendersDir,
        audioDir: config.audioDir,
        ugcDir: config.ugcDir,
        videosDir: config.videosDir,
        audioProvider: config.audioProvider,
        offlineOnly: false,
        allowMocks: mocksAllowed(config),
        avatars: new FileAvatarLibraryStore(config.dataDir),
      },
    };
  }
  // Runtime criado por uma versão anterior (hot reload): acrescenta a biblioteca de avatares sem
  // recriar o PipelineService (que guarda locks e execuções em andamento).
  g[KEY].deps.avatars ??= new FileAvatarLibraryStore(g[KEY].config.dataDir);
  return g[KEY];
}

/** Configuração SEGURA para a interface: sem API key, sem caminhos, sem variáveis privadas. */
export interface PublicAppConfig {
  stageCapabilities: StageCapabilities;
  readiness: RuntimeReadiness;
  planner: "mock" | "anthropic";
  planningAvailable: boolean;
  /** true enquanto vídeo e áudio usam providers mock (nada real é gerado ou cobrado). */
  mediaIsMock: boolean;
  /** Provider de narração: "mock" (simulado) ou "elevenlabs" (real, cobrado). */
  audioProvider: "mock" | "elevenlabs";
  videoIsMock: boolean;
  /** "remotion" = o render gera MP4 real; "mock" = nenhum arquivo é gerado. */
  renderer: "mock" | "remotion";
  defaultBudget: CostBudget;
  /** Lote 5.5: false = fluxo REAL-only; a UI esconde MOCK e nunca mostra resultado simulado como novo. */
  allowMocks: boolean;
  exchangeRate: { rate: number; source: string };
}

export function getPublicConfig(): PublicAppConfig {
  const { config, configIssues } = getRuntime();
  const capabilities = hybridCapabilities(config, process.env, configIssues);
  const allowMocks = mocksAllowed(config);
  return {
    stageCapabilities: capabilities,
    readiness: runtimeReadiness(config, configIssues),
    planner: config.llmProvider,
    planningAvailable: (config.llmProvider === "mock" && allowMocks) || capabilities.planning.available,
    allowMocks,
    mediaIsMock: config.audioProvider === "mock" && config.videoProvider === "mock",
    audioProvider: config.audioProvider,
    videoIsMock: config.videoProvider === "mock",
    renderer: config.renderer.id,
    defaultBudget: config.defaultBudget,
    exchangeRate: { rate: config.exchangeRate.rate, source: config.exchangeRate.source },
  };
}

/** Lote 6: estimativas da UX V2 (duração × qualidade), calculadas no servidor pela tabela de preços. */
export function getV2Estimates(): V2EstimateView[] {
  const config = getRuntime().config;
  return v2Estimates(new StaticPricingCatalog(PRICING_TABLE), config.exchangeRate.rate, config.ugc.provider === "krea" ? kreaUgcPricingRefs : undefined);
}

export function getPresetSummaries(): PresetSummary[] {
  const config = getRuntime().config;
  return summarizePresets(new StaticPricingCatalog(PRICING_TABLE), config.exchangeRate, config.videoProvider === "runway" ? RUNWAY_VIDEO : undefined, SIMPLE_QUALITY_PRESETS);
}

