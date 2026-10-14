import { PRESET_ORDER, QUALITY_PRESETS, type PresetQuality } from "@/config/quality-presets";
import type { ExchangeRate } from "@/domain/cost";
import type { Range } from "@/domain/quality";
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
  generatedVideoSeconds: Range;
  finalVideoSeconds: Range;
  estimatedCostBrl: Range;
  targetCostBrl: Range | undefined;
  containsPlaceholderPrices: boolean;
}

export function summarizePresets(catalog: PricingCatalog, exchangeRate: ExchangeRate): PresetSummary[] {
  return PRESET_ORDER.map((quality) => {
    const settings = QUALITY_PRESETS[quality];
    const range = estimatePresetRange(settings, resolvePricing(settings, catalog), exchangeRate.rate);
    return {
      quality,
      label: settings.label,
      description: settings.description,
      videoProviderLabel: `${settings.video.provider} / ${settings.video.model}`,
      llmModelLabel: `${settings.llm.model} (esforço ${settings.llm.effort})`,
      generatedVideoSeconds: settings.generatedVideoSeconds,
      finalVideoSeconds: settings.finalVideoSeconds,
      estimatedCostBrl: { min: range.min.brl, max: range.max.brl },
      targetCostBrl: settings.targetCostBrl,
      containsPlaceholderPrices: range.containsPlaceholderPrices,
    };
  });
}
