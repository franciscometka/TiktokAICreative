import type { AppConfig, ConfigIssue } from "@/config/env";
import { mocksAllowed } from "@/config/execution-policy";
import { kreaUgcPricingRefs } from "@/config/krea-ugc-models";
import { PRICING_TABLE } from "@/config/pricing";
import { runtimeReadiness } from "@/config/readiness";
import { SIMPLE_QUALITY_PRESETS } from "@/config/simple-presets";
import { RUNWAY_VIDEO } from "@/config/video-models";
import { StaticPricingCatalog } from "@/costs/pricing-catalog";
import { summarizePresets, type PresetSummary } from "@/costs/preset-summary";
import type { CostBudget } from "@/domain/cost";
import type { StageCapabilities } from "@/domain/execution";
import type { RuntimeReadiness } from "@/domain/readiness";
import { hybridCapabilities } from "@/pipeline/hybrid-service";
import { v2Estimates, type V2EstimateView } from "./create-v2";

/**
 * Configuração SEGURA para a interface: sem API key, sem caminhos, sem variáveis privadas.
 * Lote 7: função pura usada pelo Next (modo local) e pela API (modo cloud) — a mesma regra.
 */
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

export function publicConfigFor(config: AppConfig, issues: readonly ConfigIssue[], env: Record<string, string | undefined>, projectRoot?: string): PublicAppConfig {
  const capabilities = hybridCapabilities(config, env, issues, projectRoot);
  const allowMocks = mocksAllowed(config);
  return {
    stageCapabilities: capabilities,
    readiness: runtimeReadiness(config, [...issues]),
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
export function v2EstimatesFor(config: AppConfig): V2EstimateView[] {
  return v2Estimates(new StaticPricingCatalog(PRICING_TABLE), config.exchangeRate.rate, config.ugc.provider === "krea" ? kreaUgcPricingRefs : undefined);
}

export function presetSummariesFor(config: AppConfig): PresetSummary[] {
  return summarizePresets(new StaticPricingCatalog(PRICING_TABLE), config.exchangeRate, config.videoProvider === "runway" ? RUNWAY_VIDEO : undefined, SIMPLE_QUALITY_PRESETS);
}
