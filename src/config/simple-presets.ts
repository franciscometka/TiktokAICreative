import { QUALITY_PRESETS, type PresetQuality } from "./quality-presets";
import type { QualitySettings } from "@/domain/quality";
import { UGC_PRICING_REFS } from "./ugc-models";

export const SIMPLE_QUALITY_PRESETS: Record<PresetQuality, QualitySettings> = {
  economy: {
    ...QUALITY_PRESETS.economy,
    label: "Econômico",
    description: "15–20s, menor custo e menos vídeo gerado por IA.",
    generatedVideoSeconds: { min: 6, max: 9 },
    finalVideoSeconds: { min: 15, max: 20 },
  },
  high: {
    ...QUALITY_PRESETS.high,
    label: "Equilibrado",
    description: "20–30s, mistura apresentador e produto com bom equilíbrio de custo.",
    generatedVideoSeconds: { min: 10, max: 16 },
    finalVideoSeconds: { min: 20, max: 30 },
  },
  premium: {
    ...QUALITY_PRESETS.premium,
    label: "Premium",
    description: "30–45s, mais cenas e os melhores modelos configurados.",
  },
};

/**
 * Presets do modo AI UGC (Lote 5.3). Mesmas durações finais do fluxo simples; os segundos de
 * vídeo gerado incluem as cenas UGC (a pessoa fala a cena inteira) e o B-roll gerado.
 * Econômico: menos UGC e mais imagem; Equilibrado: principal; Premium: mais UGC e B-roll gerado.
 */
export const SIMPLE_UGC_QUALITY_PRESETS: Record<PresetQuality, QualitySettings> = {
  economy: {
    ...SIMPLE_QUALITY_PRESETS.economy,
    description: "15–20s · 2 cenas UGC (gancho e chamada) + imagem do produto.",
    generatedVideoSeconds: { min: 6, max: 13 },
    ugc: UGC_PRICING_REFS.economy,
  },
  high: {
    ...SIMPLE_QUALITY_PRESETS.high,
    description: "20–30s · 3 cenas UGC + B-roll do produto + imagem.",
    generatedVideoSeconds: { min: 14, max: 27 },
    ugc: UGC_PRICING_REFS.high,
  },
  premium: {
    ...SIMPLE_QUALITY_PRESETS.premium,
    description: "30–45s · 4 cenas UGC + 2 B-rolls, modelos superiores quando configurados.",
    generatedVideoSeconds: { min: 28, max: 45 },
    ugc: UGC_PRICING_REFS.premium,
  },
};
