import { UGC_MAX_WORDS_PER_SECOND, UGC_PRESET_PLANS, type UgcScenePlanEntry } from "@/config/ugc";
import { VIDEO_STRATEGIES } from "@/config/video-strategies";
import type { PresetQuality } from "@/config/quality-presets";
import type { CreativePlanDraft, ScenePlanDraft } from "@/domain/creative";
import type { ProductInput } from "@/domain/product";
import type { QualitySettings } from "@/domain/quality";
import { isUgcPersonSource, type UgcAudioStrategy } from "@/domain/ugc";
import { UGC_ROLE_ACTIONS } from "./ugc-script";

/**
 * Roteiro AI UGC determinístico do planner MOCK. Linguagem de creator ("Olha isso aqui…"),
 * só com fatos fornecidos (nome, benefícios/características informados) e NUNCA experiência
 * pessoal inventada. Cada fala cabe na duração da cena (≤ UGC_MAX_WORDS_PER_SECOND).
 */

const roundHalf = (x: number) => Math.round(x * 2) / 2;
const mid = (r: { min: number; max: number }) => (r.min + r.max) / 2;
const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
const stripDot = (text: string) => text.trim().replace(/[.!?]+$/, "");

/** Corta na fronteira de palavra para caber na duração (nunca acrescenta conteúdo). */
export function fitSpeech(text: string, durationSeconds: number): string {
  const max = Math.max(3, Math.floor(durationSeconds * UGC_MAX_WORDS_PER_SECOND));
  const words = text.trim().split(/\s+/);
  if (words.length <= max) return text.trim();
  return `${words.slice(0, max).join(" ").replace(/[,;:]$/, "")}.`;
}

function speechFor(entry: UgcScenePlanEntry, product: ProductInput, strategy: UgcAudioStrategy, demoDone: boolean): string {
  const fact = product.benefits[0] ?? product.features[0];
  switch (entry.source) {
    case "ugc_hook":
      return fact ? `Se você procura ${lowerFirst(stripDot(fact))}, olha isso aqui: ${product.name}.` : `Olha isso aqui: ${product.name}.`;
    case "ugc_demo":
      return "Repara no formato e no acabamento dele de perto.";
    case "ugc_benefit": {
      const detail = product.benefits[demoDone ? 1 : 0] ?? product.features[0] ?? product.benefits[0];
      return detail ? `Esse modelo chama atenção por ${lowerFirst(stripDot(detail))}.` : "Esse modelo chama atenção pelos detalhes.";
    }
    case "ugc_cta":
      return "Se fez sentido pra você, toca no carrinho e confere os detalhes.";
    case "product_broll":
      return strategy === "native_speech" ? "" : "Dá uma olhada no acabamento de perto.";
    case "product_image":
      return strategy === "native_speech" ? "" : product.features[0] ? `${stripDot(product.features[0])}.` : "Confere os detalhes nas fotos.";
  }
}

export function buildMockUgcCreative(
  product: ProductInput,
  settings: QualitySettings,
  strategy: UgcAudioStrategy,
): CreativePlanDraft {
  const quality: PresetQuality = settings.quality === "custom" ? "high" : settings.quality;
  const plan = UGC_PRESET_PLANS[quality];
  const duration = roundHalf(mid(settings.finalVideoSeconds));
  const durations = plan.map((e) => roundHalf(e.share * duration));
  durations[durations.length - 1] = roundHalf(duration - durations.slice(0, -1).reduce((a, b) => a + b, 0));
  const hasImage = product.images.length > 0;

  const scenes: ScenePlanDraft[] = plan.map((entry, i) => {
    const sceneDuration = durations[i] ?? 2;
    const source = entry.source === "product_image" && !hasImage ? "text_card" : entry.source;
    const generated = isUgcPersonSource(source) || source === "product_broll";
    const narration = fitSpeech(speechFor(entry, product, strategy, i > 1), sceneDuration);
    const person = isUgcPersonSource(source);
    const direction = generated ? VIDEO_STRATEGIES[source as keyof typeof VIDEO_STRATEGIES].direction : undefined;
    return {
      duration: sceneDuration,
      narration,
      onScreenText: source === "ugc_cta" ? "Link no carrinho" : source === "ugc_hook" ? product.name : "",
      visualDescription: person
        ? `A mesma pessoa da referência aprovada segura ${product.name}. ${UGC_ROLE_ACTIONS[source]}.`
        : source === "product_broll"
          ? `Close cinematográfico de ${product.name}, luz suave passando pela superfície.`
          : `Foto real de ${product.name} com movimento suave.`,
      generationPrompt: generated
        ? `${direction?.subjectAction || "Slow cinematic close-up of the product"}. Same person and the exact product from the approved reference. Vertical 9:16.`
        : "",
      videoDirection: direction,
      shotType: person ? "talking_head" : "product_detail",
      transition: i === 0 ? undefined : "cut",
      visualSource: source,
      motion: generated ? "none" : "ken_burns",
      requiresGeneratedVideo: generated,
      estimatedGenerationSeconds: generated ? sceneDuration : 0,
    };
  });

  const hook = scenes[0]!.narration;
  const cta = scenes[scenes.length - 1]!.narration || "Toca no carrinho e confere os detalhes.";
  return {
    concept: {
      title: `AI UGC — ${product.name}`,
      angle: "Pessoa real segurando e mostrando o produto, em tom de creator",
      hook,
      targetEmotion: "curiosidade",
      format: "ugc",
      description: "Roteiro AI UGC simulado (MOCK): a mesma pessoa apresenta o produto em todas as cenas UGC.",
    },
    duration: roundHalf(scenes.reduce((sum, s) => sum + s.duration, 0)),
    hook,
    script: scenes.map((s) => s.narration).filter(Boolean).join(" "),
    scenes,
    callToAction: cta,
  };
}
