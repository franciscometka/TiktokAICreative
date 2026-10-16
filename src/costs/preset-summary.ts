import { claudeModelName } from "@/config/llm-models";
import { PRESET_ORDER, QUALITY_PRESETS, type PresetQuality } from "@/config/quality-presets";
import type { ExchangeRate } from "@/domain/cost";
import type { PricingRef } from "@/domain/quality";
import type { QualitySettings, Range } from "@/domain/quality";
import { estimatePresetRange, resolvePricing } from "./calculate";
import type { PricingCatalog } from "./pricing-catalog";

/** Dados prontos para o card de qualidade (a UI só formata). */
export interface PresetSummary {
  quality: PresetQuality;
  label: string;
  description: string;
  videoProviderLabel: string;
  /** Modelo Claude usado no planejamento deste preset. */
  llmModelLabel: string;
  /** Nome amigável do modelo (ex.: "Claude Sonnet 5.5"). */
  llmModelName: string;
  llmEffort: string;
  generatedVideoSeconds: Range;
  finalVideoSeconds: Range;
  estimatedCostBrl: Range;
  targetCostBrl: Range | undefined;
  containsPlaceholderPrices: boolean;
}

export function summarizePresets(catalog: PricingCatalog, exchangeRate: ExchangeRate, videoChoice?: PricingRef, presets: Record<PresetQuality, QualitySettings> = QUALITY_PRESETS): PresetSummary[] {
  return PRESET_ORDER.map((quality) => {
    const settings = videoChoice ? { ...presets[quality], video: videoChoice } : presets[quality];
    const range = estimatePresetRange(settings, resolvePricing(settings, catalog), exchangeRate.rate);
    return {
      quality,
      label: settings.label,
      description: settings.description,
      videoProviderLabel: `${settings.video.provider} / ${settings.video.model}`,
      llmModelLabel: `${settings.llm.model} (esforço ${settings.llm.effort})`,
      llmModelName: claudeModelName(settings.llm.model),
      llmEffort: settings.llm.effort,
      generatedVideoSeconds: settings.generatedVideoSeconds,
      finalVideoSeconds: settings.finalVideoSeconds,
      estimatedCostBrl: { min: range.min.brl, max: range.max.brl },
      targetCostBrl: settings.targetCostBrl,
      containsPlaceholderPrices: range.containsPlaceholderPrices,
    };
  });
}
