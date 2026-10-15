import { createHybridPipelineService, hybridCapabilities } from "@/pipeline/hybrid-service";
import type { StageCapabilities } from "@/domain/execution";
import type { AppDeps } from "@/application/campaign-actions";
import { loadAppConfig, type AppConfig } from "@/config/env";
import { RUNWAY_VIDEO } from "@/config/video-models";
import { PRICING_TABLE } from "@/config/pricing";
import { summarizePresets, type PresetSummary } from "@/costs/preset-summary";
import { StaticPricingCatalog } from "@/costs/pricing-catalog";
import type { CostBudget } from "@/domain/cost";
import { LocalUploadStore } from "@/storage/upload-store";

/**
 * Runtime do processo Next.js (SERVIDOR). Um único PipelineService por processo: ele guarda os
 * locks por campanha e os planejamentos em execução. Guardado em globalThis para sobreviver ao
 * hot reload do `next dev` (senão um planejamento em andamento pareceria interrompido).
 *
 * Só importar a partir de Server Components, Server Actions e route handlers.
 */

interface Runtime {
  config: AppConfig;
  deps: AppDeps;
}

const KEY = Symbol.for("tiktok-ai-creative-factory.runtime");
type GlobalWithRuntime = typeof globalThis & { [KEY]?: Runtime };

export function getRuntime(): Runtime {
  const g = globalThis as GlobalWithRuntime;
  if (!g[KEY]) {
    const config = loadAppConfig();
    g[KEY] = {
      config,
      deps: {
        service: createHybridPipelineService(config),
        uploads: new LocalUploadStore(config.uploadsDir),
        rendersDir: config.rendersDir,
        audioDir: config.audioDir,
        videosDir: config.videosDir,
        audioProvider: "mock",
        offlineOnly: false,
      },
    };
  }
  return g[KEY];
}

/** Configuração SEGURA para a interface: sem API key, sem caminhos, sem variáveis privadas. */
export interface PublicAppConfig {
  stageCapabilities: StageCapabilities;
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
  exchangeRate: { rate: number; source: string };
}

export function getPublicConfig(): PublicAppConfig {
  const { config } = getRuntime();
  return {
    stageCapabilities: hybridCapabilities(config),
    planner: "mock",
    planningAvailable: true,
    mediaIsMock: true,
    audioProvider: "mock",
    videoIsMock: true,
    renderer: "mock",
    defaultBudget: config.defaultBudget,
    exchangeRate: { rate: config.exchangeRate.rate, source: config.exchangeRate.source },
  };
}

export function getPresetSummaries(): PresetSummary[] {
  const config = getRuntime().config;
  return summarizePresets(new StaticPricingCatalog(PRICING_TABLE), config.exchangeRate, config.videoProvider === "runway" ? RUNWAY_VIDEO : undefined);
}

