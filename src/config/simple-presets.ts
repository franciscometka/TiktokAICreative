import { QUALITY_PRESETS, type PresetQuality } from "./quality-presets";
import type { QualitySettings } from "@/domain/quality";

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
