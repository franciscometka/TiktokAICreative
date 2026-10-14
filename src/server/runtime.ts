import type { AppDeps } from "@/application/campaign-actions";
import { loadAppConfig, type AppConfig } from "@/config/env";
import { PRICING_TABLE } from "@/config/pricing";
import { summarizePresets, type PresetSummary } from "@/costs/preset-summary";
import { StaticPricingCatalog } from "@/costs/pricing-catalog";
import type { CostBudget } from "@/domain/cost";
import { createPipelineService } from "@/pipeline/create-pipeline-service";
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
        service: createPipelineService(config),
        uploads: new LocalUploadStore(config.uploadsDir),
        rendersDir: config.rendersDir,
      },
    };
  }
  return g[KEY];
}

/** Configuração SEGURA para a interface: sem API key, sem caminhos, sem variáveis privadas. */
export interface PublicAppConfig {
  planner: "mock" | "anthropic";
  planningAvailable: boolean;
  /** true enquanto vídeo e áudio usam providers mock (nada real é gerado ou cobrado). */
  mediaIsMock: boolean;
  /** "remotion" = o render gera MP4 real; "mock" = nenhum arquivo é gerado. */
  renderer: "mock" | "remotion";
  defaultBudget: CostBudget;
  exchangeRate: { rate: number; source: string };
}

export function getPublicConfig(): PublicAppConfig {
  const { config, deps } = getRuntime();
  return {
    planner: config.llmProvider,
    planningAvailable: deps.service.planningAvailable(),
    mediaIsMock: config.videoProvider === "mock" && config.audioProvider === "mock",
    renderer: config.renderer.id,
    defaultBudget: config.defaultBudget,
    exchangeRate: { rate: config.exchangeRate.rate, source: config.exchangeRate.source },
  };
}

export function getPresetSummaries(): PresetSummary[] {
  return summarizePresets(new StaticPricingCatalog(PRICING_TABLE), getRuntime().config.exchangeRate);
}

