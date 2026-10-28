import { EDIT_POLICY, UGC_EDITORIAL_PLANS, UGC_PRESENTER_PLANS, type EditorialPlanEntry, type PresenterPlanEntry } from "@/config/edit-policy";
import { UGC_MAX_WORDS_PER_SECOND } from "@/config/ugc";
import { VIDEO_STRATEGIES } from "@/config/video-strategies";
import type { PresetQuality } from "@/config/quality-presets";
import type { CreativePlanDraft, ScenePlanDraft } from "@/domain/creative";
import type { ProductInput } from "@/domain/product";
import type { QualitySettings } from "@/domain/quality";
import type { UgcAudioStrategy, UgcPersonSource } from "@/domain/ugc";
import { UGC_ROLE_ACTIONS } from "./ugc-script";
import { shortProductName, splitMasterScript, splitSentences } from "./master-script";
import { DURATION_TARGETS, type DurationTarget, type TargetDuration } from "@/config/duration-targets";

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

/**
 * Presenter Only (Lote 5.7): fala de creator brasileiro em 5–6 trechos (hook → produto → detalhes
 * → demonstração → fechamento + CTA natural). Só fatos fornecidos; nada de experiência inventada.
 */
function presenterSpeech(entry: PresenterPlanEntry, product: ProductInput, detailIndex: number): string {
  const facts = [...product.features, ...product.benefits].map(stripDot).filter(Boolean);
  const benefit = product.benefits[0] ? lowerFirst(stripDot(product.benefits[0])) : undefined;
  switch (entry.beat) {
    case "hook":
      return benefit ? `Se você está procurando ${benefit}, olha esse modelo aqui. Esse é o ${product.name}.` : `Olha esse modelo aqui que eu quero mostrar pra vocês. Esse é o ${product.name}.`;
    case "intro":
      return "Deixa eu mostrar ele de pertinho. Repara no formato e no tamanho dele na mão.";
    case "details": {
      const fact = facts[detailIndex];
      const next = facts[detailIndex + 1];
      if (!fact) return "Repara no acabamento dele, nos detalhes e em como ele é na mão.";
      return next ? `Um detalhe que chama atenção: ${lowerFirst(fact)}. E também ${lowerFirst(next)}.` : `Um detalhe que chama atenção: ${lowerFirst(fact)}. Dá pra ver bem aqui.`;
    }
    case "demo":
      return "Olha aqui de lado, girando devagar, pra vocês verem os detalhes de perto, sem pressa.";
    case "closing_cta":
      return "Então é isso. Se você curtiu esse modelo, dá uma olhada no carrinho e confere os detalhes.";
  }
}

function buildMockPresenterCreative(product: ProductInput, quality: PresetQuality): CreativePlanDraft {
  let detailIndex = 0;
  const scenes: ScenePlanDraft[] = UGC_PRESENTER_PLANS[quality].map((entry, i) => {
    const speech = fitSpeech(presenterSpeech(entry, product, detailIndex), entry.seconds);
    if (entry.beat === "details") detailIndex += 2;
    const direction = VIDEO_STRATEGIES[entry.source].direction;
    return {
      duration: entry.seconds, narration: speech, onScreenText: entry.beat === "closing_cta" ? EDIT_POLICY.ctaLabel : "",
      visualDescription: `Apresentadora (mesma pessoa da referência aprovada) segura ${product.name}. ${UGC_ROLE_ACTIONS[entry.source]}.`,
      generationPrompt: `${direction.subjectAction}. Same person and the exact product from the approved reference. Vertical 9:16.`,
      videoDirection: direction, shotType: "talking_head", transition: i === 0 ? undefined : "cut",
      visualSource: entry.source, motion: "none", requiresGeneratedVideo: true, estimatedGenerationSeconds: entry.seconds,
    };
  });
  const hook = scenes[0]!.narration;
  return {
    concept: {
      title: `AI UGC — ${product.name}`, angle: "Creator mostrando o produto real do começo ao fim, sem tom de comercial",
      hook, targetEmotion: "curiosidade", format: "ugc",
      description: "Roteiro AI UGC simulado (MOCK): Presenter Only — a mesma apresentadora o vídeo inteiro.",
    },
    duration: scenes.reduce((sum, s) => sum + s.duration, 0),
    hook,
    script: scenes.map((s) => s.narration).join(" "),
    scenes,
    callToAction: scenes[scenes.length - 1]!.narration,
  };
}

/**
 * Lote 6 — roteiro mestre MOCK para 30/45/60s: UM texto contínuo (hook → corpo → demonstração →
 * fechamento → CTA) com só fatos fornecidos; depois dividido em trechos consecutivos.
 */
export function buildMockMasterScriptText(product: ProductInput, target: DurationTarget, personalization?: { cta?: string }): string {
  // Lote 6.2 (Script V2): FEATURE → CONTEXTO → AÇÃO VISUAL, só com fatos fornecidos, sem muletas
  // repetidas e sem linguagem de catálogo; o nome longo do anúncio vira um nome curto na fala.
  const facts = [...product.features, ...product.benefits].map(stripDot).filter(Boolean);
  const benefit = product.benefits[0] ? lowerFirst(stripDot(product.benefits[0])) : undefined;
  const short = shortProductName(product.name);
  const hook = benefit ? `Se você procura ${benefit}, repara nesse ${short} aqui.` : `Deixa eu te mostrar esse ${short} de pertinho.`;
  const body = [
    `Esse é o ${product.name}.`,
    "Vou girar devagar pra você ver o formato.",
    ...facts.slice(0, 3).flatMap((fact, i) => (i === 0 ? [`Uma coisa importante: ${lowerFirst(fact)}.`, "Dá pra ver isso aqui enquanto eu viro na mão."] : i === 1 ? [`Ele também tem ${lowerFirst(fact)}, repara nessa parte.`] : [`Vale conferir mais um ponto: ${lowerFirst(fact)}.`])),
  ];
  const demo = ["Aqui de lado dá pra notar o acabamento com calma.", "Na mão dá pra ter uma boa noção do tamanho real."];
  const filler = [
    "De frente o formato fica bem claro.", "Mais de perto dá pra reparar em cada parte.", "Virando de novo, aparece o outro lado.",
    "Daqui de cima dá pra ver mais um detalhe.", "Por esse ângulo o acabamento aparece melhor.", "Embaixo também tem uma parte que vale notar.",
  ];
  const closing = `Então, esse é o ${short} que eu queria te mostrar.`;
  const cta = personalization?.cta?.trim() ? `${stripDot(personalization.cta)}.` : "Se fez sentido pra você, dá uma olhada no carrinho e vale conferir os detalhes.";
  const sentences = [hook, ...body, ...demo];
  const words = (list: readonly string[]) => list.join(" ").split(/\s+/).length;
  for (const line of filler) {
    if (words([...sentences, closing, cta]) >= target.words.min) break;
    sentences.push(line);
  }
  while (words([...sentences, closing, cta]) > target.words.max && sentences.length > target.clips) sentences.splice(-1, 1);
  return [...sentences, closing, cta].join(" ");
}

function presenterSourcesFor(clips: number): UgcPersonSource[] {
  const middle: UgcPersonSource[] = ["ugc_demo", "ugc_benefit", "ugc_demo", "ugc_benefit"];
  return Array.from({ length: clips }, (_, i) => (i === 0 ? "ugc_hook" : i === clips - 1 ? "ugc_cta" : middle[(i - 1) % middle.length]!));
}

function buildMockDurationCreative(product: ProductInput, target: DurationTarget, personalization?: { cta?: string }): CreativePlanDraft {
  const script = buildMockMasterScriptText(product, target, personalization);
  const segments = splitMasterScript(script, target.clips);
  const scenes: ScenePlanDraft[] = presenterSourcesFor(target.clips).map((source, i) => {
    const direction = VIDEO_STRATEGIES[source].direction;
    return {
      duration: target.clipSeconds, narration: segments[i]!, onScreenText: i === target.clips - 1 ? EDIT_POLICY.ctaLabel : "",
      visualDescription: `Apresentadora (mesma pessoa da referência aprovada) segura ${product.name}. ${UGC_ROLE_ACTIONS[source]}.`,
      generationPrompt: `${direction.subjectAction}. Same person and the exact product from the approved reference. Vertical 9:16.`,
      videoDirection: direction, shotType: "talking_head", transition: i === 0 ? undefined : "cut",
      visualSource: source, motion: "none", requiresGeneratedVideo: true, estimatedGenerationSeconds: target.clipSeconds,
    };
  });
  const sentences = splitSentences(script);
  return {
    concept: {
      title: `AI UGC — ${product.name}`, angle: "Creator mostrando o produto real do começo ao fim, num roteiro único", hook: sentences[0]!,
      targetEmotion: "curiosidade", format: "ugc", description: `Roteiro mestre simulado (MOCK) de ${target.label}: a mesma apresentadora o vídeo inteiro.`,
    },
    duration: Math.round(scenes.reduce((sum, s) => sum + s.duration, 0) * 100) / 100,
    hook: sentences[0]!, script, scenes, callToAction: sentences.at(-1)!,
  };
}

export function buildMockUgcCreative(product: ProductInput, settings: QualitySettings, _strategy: UgcAudioStrategy, presenterOnly = true, targetDuration?: TargetDuration, personalization?: { cta?: string }): CreativePlanDraft {
  const quality: PresetQuality = settings.quality === "custom" ? "high" : settings.quality;
  if (presenterOnly && targetDuration) return buildMockDurationCreative(product, DURATION_TARGETS[targetDuration], personalization);
  if (presenterOnly) return buildMockPresenterCreative(product, quality);
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
