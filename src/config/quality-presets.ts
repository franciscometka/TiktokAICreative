import type { GenerationQuality, QualitySettings } from "@/domain/quality";
import { PLANNING_LLM } from "./llm-models";
import { NARRATION_TTS } from "./tts-models";

export type PresetQuality = Exclude<GenerationQuality, "custom">;

const LOCAL_RENDER = { provider: "local", model: "remotion" } as const;

/**
 * Presets iniciais. São pontos de partida AJUSTÁVEIS, não verdades absolutas.
 * Os custos efetivos vêm sempre de config/pricing.ts × plano real.
 * targetCostBrl é só a meta de referência para os cards e para testes de sanidade.
 */
export const QUALITY_PRESETS: Record<PresetQuality, QualitySettings> = {
  economy: {
    quality: "economy",
    label: "Econômico",
    description: "Para testar produtos e ideias em volume.",
    video: { provider: "unassigned-video", model: "economy-tier" },
    audio: NARRATION_TTS.economy,
    llm: PLANNING_LLM.economy,
    rendering: LOCAL_RENDER,
    generatedVideoSeconds: { min: 8, max: 12 },
    finalVideoSeconds: { min: 20, max: 30 },
    targetCostBrl: { min: 3, max: 6 },
    llmTokensPerCreative: { input: 2_000, output: 6_000 },
    narrationCharsPerSecond: 15,
  },
  high: {
    quality: "high",
    label: "Alta qualidade",
    description: "Equilíbrio entre custo e qualidade.",
    video: { provider: "unassigned-video", model: "high-tier" },
    audio: NARRATION_TTS.high,
    llm: PLANNING_LLM.high,
    rendering: LOCAL_RENDER,
    generatedVideoSeconds: { min: 12, max: 20 },
    finalVideoSeconds: { min: 25, max: 35 },
    targetCostBrl: { min: 8, max: 15 },
    llmTokensPerCreative: { input: 2_000, output: 6_000 },
    narrationCharsPerSecond: 15,
  },
  premium: {
    quality: "premium",
    label: "Premium",
    description: "Mais vídeo gerado por IA e planejamento com o modelo mais avançado.",
    video: { provider: "unassigned-video", model: "premium-tier" },
    audio: NARRATION_TTS.premium,
    llm: PLANNING_LLM.premium,
    rendering: LOCAL_RENDER,
    generatedVideoSeconds: { min: 20, max: 30 },
    finalVideoSeconds: { min: 30, max: 45 },
    targetCostBrl: { min: 25, max: 50 },
    llmTokensPerCreative: { input: 2_000, output: 7_000 },
    narrationCharsPerSecond: 15,
  },
};

export const PRESET_ORDER: readonly PresetQuality[] = ["economy", "high", "premium"];
