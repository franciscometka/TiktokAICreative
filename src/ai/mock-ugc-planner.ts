import { EDIT_POLICY, UGC_EDITORIAL_PLANS, type EditorialPlanEntry } from "@/config/edit-policy";
import { UGC_MAX_WORDS_PER_SECOND } from "@/config/ugc";
import { VIDEO_STRATEGIES } from "@/config/video-strategies";
import type { PresetQuality } from "@/config/quality-presets";
import type { CreativePlanDraft, ScenePlanDraft } from "@/domain/creative";
import type { ProductInput } from "@/domain/product";
import type { QualitySettings } from "@/domain/quality";
import type { UgcAudioStrategy, UgcPersonSource } from "@/domain/ugc";
import { UGC_ROLE_ACTIONS } from "./ugc-script";

/**
 * Roteiro AI UGC determinístico do planner MOCK (Editor V2). Estrutura de creator:
 *   HOOK → observação neutra → produto → detalhe/demonstração → benefício informado → CTA curto.
 * Só fatos fornecidos (nome, benefícios/características) e NUNCA experiência pessoal inventada.
 * A-roll = apresentadora falando (espinha de áudio); B-roll = detalhe do frame de referência,
 * por cima do áudio (o editorial converte em overlay). Frases curtas, com folga na duração.
 */

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
const stripDot = (text: string) => text.trim().replace(/[.!?]+$/, "");

/** Corta na fronteira de palavra para caber com folga (nunca acrescenta conteúdo). */
export function fitSpeech(text: string, durationSeconds: number): string {
  const usable = Math.max(1, durationSeconds - EDIT_POLICY.handles.aroll.headSeconds - EDIT_POLICY.handles.aroll.tailSeconds);
  const max = Math.max(3, Math.floor(usable * EDIT_POLICY.speechFillRatio * UGC_MAX_WORDS_PER_SECOND));
  const words = text.trim().split(/\s+/);
  if (words.length <= max) return text.trim();
  return `${words.slice(0, max).join(" ").replace(/[,;:]$/, "")}.`;
}

function speechFor(source: UgcPersonSource, product: ProductInput, arollIndex: number, arollCount: number): string {
  const benefit = product.benefits[0];
  const feature = product.features[0];
  const second = product.benefits[1] ?? product.features[1];
  switch (source) {
    case "ugc_hook":
      return benefit
        ? `Se você quer ${lowerFirst(stripDot(benefit))}, repara nisso. É o ${product.name}.`
        : `Repara nisso aqui. É o ${product.name}.`;
    case "ugc_demo":
      return feature ? `Olha de perto. ${stripDot(feature)}.` : "Olha o formato dele de perto.";
    case "ugc_benefit":
      return second ? `E tem mais: ${lowerFirst(stripDot(second))}.` : "Repara no acabamento dos detalhes.";
    case "ugc_cta":
      // Com só dois A-rolls, o CTA também carrega o detalhe principal.
      return arollCount <= 2 && feature
        ? `${stripDot(feature)}. Se fez sentido, tá no carrinho.`
        : arollIndex > 0 ? "Se fez sentido pra você, tá no carrinho." : "Confere no carrinho.";
  }
}

function sceneFrom(entry: EditorialPlanEntry, product: ProductInput, arollIndex: number, arollCount: number): ScenePlanDraft {
  if (entry.role === "broll") {
    return {
      duration: entry.seconds, narration: "", onScreenText: "",
      visualDescription: `B-roll: ${entry.detail} (recorte do frame de referência, mesmo ambiente); o áudio da apresentadora continua.`,
      generationPrompt: "", shotType: "product_detail", transition: "cut", visualSource: "reference_detail", motion: "none",
      requiresGeneratedVideo: false, estimatedGenerationSeconds: 0,
    };
  }
  const direction = VIDEO_STRATEGIES[entry.source].direction;
  return {
    duration: entry.seconds,
    narration: fitSpeech(speechFor(entry.source, product, arollIndex, arollCount), entry.seconds),
    onScreenText: entry.source === "ugc_cta" ? EDIT_POLICY.ctaLabel : "",
    visualDescription: `A-roll: a mesma pessoa da referência aprovada segura ${product.name}. ${UGC_ROLE_ACTIONS[entry.source]}.`,
    generationPrompt: `${direction.subjectAction}. Same person and the exact product from the approved reference. Vertical 9:16.`,
    videoDirection: direction,
    shotType: "talking_head",
    transition: arollIndex === 0 ? undefined : "cut",
    visualSource: entry.source,
    motion: "none",
    requiresGeneratedVideo: true,
    estimatedGenerationSeconds: entry.seconds,
  };
}

export function buildMockUgcCreative(product: ProductInput, settings: QualitySettings, _strategy: UgcAudioStrategy): CreativePlanDraft {
  const quality: PresetQuality = settings.quality === "custom" ? "high" : settings.quality;
  const entries = UGC_EDITORIAL_PLANS[quality];
  const arollCount = entries.filter((e) => e.role === "aroll").length;
  let arollIndex = 0;
  const scenes = entries.map((entry) => {
    const scene = sceneFrom(entry, product, arollIndex, arollCount);
    if (entry.role === "aroll") arollIndex++;
    return scene;
  });
  const hook = scenes[0]!.narration;
  const cta = scenes.findLast((s) => s.visualSource === "ugc_cta")?.narration || "Confere no carrinho.";
  return {
    concept: {
      title: `AI UGC — ${product.name}`,
      angle: "Creator mostrando o produto real em um vídeo contínuo, sem tom de comercial",
      hook,
      targetEmotion: "curiosidade",
      format: "ugc",
      description: "Roteiro AI UGC simulado (MOCK): A-roll contínuo da mesma pessoa + B-roll de detalhe por cima do áudio.",
    },
    duration: scenes.reduce((sum, s) => sum + s.duration, 0),
    hook,
    script: scenes.map((s) => s.narration).filter(Boolean).join(" "),
    scenes,
    callToAction: cta,
  };
}
