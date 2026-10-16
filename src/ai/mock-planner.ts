import type { CampaignPlanDraft, HookDraft } from "@/domain/campaign";
import type { CreativePlanDraft, CreativeStyle, ScenePlanDraft, ShotType } from "@/domain/creative";
import type { ProductInput } from "@/domain/product";
import type { QualitySettings } from "@/domain/quality";
import type { IdGenerator } from "@/lib/ids";
import { hydrateCampaignPlan } from "./hydrate";
import type { CreativePlanner, PlanningRequest, PlanningResult, PlanningWorstCase } from "./planner";
import { hookCountFor } from "./prompts/campaign-plan.v1";

/**
 * Planner FALSO e determinístico. Não chama LLM. Textos marcados com [MOCK].
 * Serve para exercitar o pipeline inteiro (custos, aprovação, geração mock) sem gastar.
 * O uso de tokens retornado é SIMULADO a partir do preset (para exercitar o ledger).
 */
export class MockCreativePlanner implements CreativePlanner {
  readonly id = "mock";

  constructor(
    private readonly ids: IdGenerator,
    /** Atraso artificial (ms) para simular a demora do Claude na interface. 0 = imediato. */
    private readonly delayMs = 0,
  ) {}

  worstCase(request: PlanningRequest): PlanningWorstCase {
    const tokens = request.settings.llmTokensPerCreative;
    return {
      estimatedInputTokens: tokens.input * request.creativeCount,
      maxOutputTokens: tokens.output * request.creativeCount,
      maxAttempts: 1,
    };
  }

  async plan(request: PlanningRequest): Promise<PlanningResult> {
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    const draft = buildMockDraft(request);
    const tokens = request.settings.llmTokensPerCreative;
    const model = request.settings.llm.model;
    return {
      plan: hydrateCampaignPlan(draft, request.product, this.ids),
      calls: [
        {
          attempt: 1,
          requestedModel: model,
          servedModel: model,
          requestId: null,
          usage: {
            inputTokens: tokens.input * request.creativeCount,
            outputTokens: tokens.output * request.creativeCount,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
          },
          stopReason: "end_turn",
          outcome: "valid",
          durationMs: 0,
        },
      ],
      plannerId: this.id,
      provider: "mock",
      promptId: "mock-campaign-plan",
      promptVersion: "0.0.0",
      simulated: true,
    };
  }
}

interface SceneTemplate {
  share: number;
  generated: boolean;
  shotType: ShotType;
  role: "hook" | "problem" | "reveal" | "benefits" | "demo" | "cta";
}

const SCENE_TEMPLATES: readonly SceneTemplate[] = [
  { share: 0.12, generated: true, shotType: "close_up", role: "hook" },
  { share: 0.18, generated: false, shotType: "text_card", role: "problem" },
  { share: 0.18, generated: true, shotType: "product_detail", role: "reveal" },
  { share: 0.22, generated: false, shotType: "product_detail", role: "benefits" },
  { share: 0.15, generated: true, shotType: "hands", role: "demo" },
  { share: 0.15, generated: false, shotType: "text_card", role: "cta" },
];

const roundHalf = (x: number) => Math.round(x * 2) / 2;
const mid = (r: { min: number; max: number }) => (r.min + r.max) / 2;

export function buildMockDraft(request: PlanningRequest): CampaignPlanDraft {
  const { product, styles, creativeCount, settings } = request;
  const creatives = Array.from({ length: creativeCount }, (_, i) =>
    applyBrief(buildCreative(product, styles[i % styles.length] ?? "ugc", settings), request),
  );
  const hooks: HookDraft[] = Array.from({ length: hookCountFor(creativeCount) }, (_, i) => {
    const style = styles[i % styles.length] ?? "ugc";
    return { text: `${hookText(product, style)} #${i + 1}`, angle: `[MOCK] ângulo ${style}`, style };
  });
  return {
    analysis: {
      summary: `[MOCK] Análise simulada de ${product.name}. Nenhum LLM foi chamado.`,
      targetAudiences: [product.targetAudience ?? "[MOCK] público geral do TikTok Shop"],
      problemsSolved: ["Problema ou desejo não informado; revisar antes de gerar."],
      benefits: product.benefits.length > 0 ? product.benefits : ["Benefícios não informados; nenhuma promessa foi criada."],
      differentiators: product.features,
      sellingAngles: styles.map((s) => `[MOCK] ${s}`),
      objections: ["[MOCK] preço", "[MOCK] confiança na entrega"],
      communicationRisks: ["[MOCK] não prometer resultados"],
      missingInformation: ["[MOCK] prova social"],
    },
    hooks,
    creatives,
  };
}

function hookText(product: ProductInput, _style: CreativeStyle): string {
  return `Olha só este ${product.name}.`;
}

function buildCreative(
  product: ProductInput,
  style: CreativeStyle,
  settings: QualitySettings,
): CreativePlanDraft {
  const duration = roundHalf(mid(settings.finalVideoSeconds));
  const durations = SCENE_TEMPLATES.map((t) => roundHalf(t.share * duration));
  const lastIndex = durations.length - 1;
  durations[lastIndex] = duration - durations.slice(0, lastIndex).reduce((a, b) => a + b, 0);

  // Decide quais cenas usam vídeo IA até cobrir a meta de segundos gerados.
  const targetGen = mid(settings.generatedVideoSeconds);
  const generated = SCENE_TEMPLATES.map((t) => t.generated);
  const genDuration = () => durations.reduce((acc, d, i) => acc + (generated[i] ? d : 0), 0);
  SCENE_TEMPLATES.forEach((t, i) => {
    if (genDuration() < targetGen && !generated[i] && t.role !== "cta") generated[i] = true;
  });
  const totalGenDuration = genDuration();

  const hook = hookText(product, style);
  const benefit = product.benefits[0];
  const cta = "Confira as informações do produto antes de escolher.";

  const scenes: ScenePlanDraft[] = SCENE_TEMPLATES.map((t, i) => {
    const sceneDuration = durations[i] ?? 0;
    const isGenerated = generated[i] ?? false;
    const genSeconds = isGenerated
      ? Math.max(0.5, Math.min(sceneDuration, roundHalf((targetGen * sceneDuration) / totalGenDuration)))
      : 0;
    const narration = t.role === "hook" ? hook
      : t.role === "problem" ? `Se você está procurando uma opção como ${product.name}, vale conhecer os detalhes.`
      : t.role === "reveal" ? product.description
      : t.role === "benefits" ? (benefit ? `Entre os benefícios informados está: ${benefit}.` : "Os benefícios ainda precisam ser confirmados pelo vendedor.")
      : t.role === "demo" ? `Veja as imagens e as características confirmadas de ${product.name}.`
      : cta;
    return {
      duration: sceneDuration,
      narration,
      onScreenText: t.role === "cta" ? "Link no carrinho" : `[MOCK] ${t.role}`,
      visualDescription: `[MOCK] ${t.role} com ${product.name}`,
      generationPrompt: isGenerated
        ? `[MOCK] Vertical 9:16, ${t.shotType}, ${product.name}, estética TikTok nativa`
        : "",
      shotType: t.shotType,
      transition: i === 0 ? undefined : "cut",
      visualSource: isGenerated ? "generated_video" : product.images.length > 0 && t.role !== "cta" ? "product_image" : "text_card",
      motion: isGenerated ? "none" : "ken_burns",
      requiresGeneratedVideo: isGenerated,
      estimatedGenerationSeconds: genSeconds,
    };
  });

  return {
    concept: {
      title: `[MOCK] ${style} — ${product.name}`,
      angle: `[MOCK] ângulo ${style}`,
      hook,
      targetEmotion: "[MOCK] curiosidade",
      format: style,
      description: "[MOCK] Conceito simulado para testes do pipeline.",
    },
    duration,
    hook,
    script: scenes.map((s) => s.narration).join(" "),
    scenes,
    callToAction: cta,
  };
}

function applyBrief(creative: CreativePlanDraft, request: PlanningRequest): CreativePlanDraft {
  if (!request.videoConcept && !request.scriptMode && !request.projectName) return creative;
  const p = request.product;
  const generated = [
    `Conheça ${p.name}.`, p.description,
    p.features.length ? `Entre os detalhes estão ${p.features.slice(0, 2).join(" e ")}.` : `Veja os detalhes de ${p.name}.`,
    p.benefits[0] ?? `Compare as características de ${p.name}.`,
    "Confira as imagens e as informações do produto.", "Veja os detalhes antes de escolher.",
  ].join(" ");
  const script = request.scriptMode === "manual" ? request.script?.trim() : generated;
  if (!script) throw new Error("Roteiro manual vazio.");
  const words = script.split(/\s+/);
  if (words.length > 400) throw new Error("Use até 400 palavras por roteiro.");
  const size = Math.ceil(words.length / creative.scenes.length);
  const scenes = creative.scenes.map((scene, i) => {
    const narration = words.slice(i * size, (i + 1) * size).join(" ");
    // O preset define a duração prometida na UX. Distribuir outro texto não pode
    // encurtar silenciosamente o vídeo depois que a pessoa escolheu essa faixa.
    const duration = scene.duration;
    return { ...scene, narration, duration, estimatedGenerationSeconds: scene.requiresGeneratedVideo ? Math.min(duration, scene.estimatedGenerationSeconds) : 0,
      visualDescription: `${request.videoConcept || "Apresentação do produto"} — cena ${i + 1}` };
  });
  return { ...creative, concept: { ...creative.concept, title: request.projectName || creative.concept.title, description: request.videoConcept || creative.concept.description },
    script, scenes, duration: Math.round(scenes.reduce((sum, scene) => sum + scene.duration, 0) * 10) / 10 };
}
