import type { CampaignPlan } from "@/domain/campaign";
import { CreativePlanSchema, generatedVideoSeconds, type CreativePlan, type ScenePlan } from "@/domain/creative";
import type { CreativeReview, PlanAdjustment, PlanEvaluation, PlanIssue } from "@/domain/plan-evaluation";
import type { QualitySettings } from "@/domain/quality";
import { roundBrl, usdToBrl } from "@/lib/money";
import { futureCostLines, sumLinesUsd, type ResolvedPricing } from "./calculate";

/**
 * Regras PURAS que comparam um plano com o preset escolhido.
 * Não confiamos no LLM para respeitar os limites: tudo é recalculado aqui.
 */

/** Uma cena gerada não deve ficar com menos que isso após redução (clipe curto demais não vale). */
export const MIN_GENERATED_SECONDS_PER_SCENE = 2;

type MediaPricing = Omit<ResolvedPricing, "llm">;

export function evaluatePlanAgainstPreset(
  plan: CreativePlan,
  settings: QualitySettings,
  pricing: MediaPricing,
  exchangeRate: number,
): PlanEvaluation {
  const gen = generatedVideoSeconds(plan);
  const allowed = settings.generatedVideoSeconds;
  const final = settings.finalVideoSeconds;
  const errors: PlanIssue[] = [];
  const warnings: PlanIssue[] = [];

  if (gen > allowed.max) {
    errors.push({
      code: "GENERATED_SECONDS_ABOVE_PRESET",
      message: `Plano usa ${gen}s de vídeo IA; o preset permite no máximo ${allowed.max}s`,
    });
  } else if (gen === 0) {
    warnings.push({ code: "NO_GENERATED_VIDEO", message: "Nenhuma cena usa vídeo gerado por IA" });
  } else if (gen < allowed.min) {
    warnings.push({
      code: "GENERATED_SECONDS_BELOW_PRESET",
      message: `Plano usa ${gen}s de vídeo IA; o preset prevê ${allowed.min}–${allowed.max}s (mais barato que o previsto)`,
    });
  }
  if (plan.duration < final.min || plan.duration > final.max) {
    warnings.push({
      code: "FINAL_DURATION_OUT_OF_RANGE",
      message: `Duração final ${plan.duration}s fora da faixa ${final.min}–${final.max}s`,
    });
  }

  const futureUsd = sumLinesUsd(futureCostLines(plan, pricing));
  return {
    creativeId: plan.id,
    valid: errors.length === 0,
    generatedSeconds: gen,
    allowedGeneratedSeconds: allowed,
    finalSeconds: plan.duration,
    allowedFinalSeconds: final,
    errors,
    warnings,
    estimatedFutureCostBrl: roundBrl(usdToBrl(futureUsd, exchangeRate)),
  };
}

function toProductImage(scene: ScenePlan): ScenePlan {
  return {
    ...scene,
    visualSource: "product_image",
    motion: scene.motion === "none" ? "ken_burns" : scene.motion,
    requiresGeneratedVideo: false,
    estimatedGenerationSeconds: 0,
    generationPrompt: "",
  };
}

/**
 * Estratégia DETERMINÍSTICA (sem nova chamada paga) para trazer os segundos de IA para o máximo do preset:
 * percorre as cenas geradas da última para a primeira (o primeiro clipe gerado — normalmente o gancho —
 * é protegido); reduz os segundos da cena se ela continuar com pelo menos MIN_GENERATED_SECONDS_PER_SCENE,
 * senão converte a cena para imagem do produto com movimento. Se ainda exceder, reduz o clipe protegido.
 * Planos dentro do limite são devolvidos sem alteração.
 */
export function fitPlanToPreset(
  plan: CreativePlan,
  settings: QualitySettings,
): { plan: CreativePlan; adjustments: PlanAdjustment[] } {
  const max = settings.generatedVideoSeconds.max;
  let total = generatedVideoSeconds(plan);
  if (total <= max) return { plan, adjustments: [] };

  const scenes = plan.scenes.map((s) => ({ ...s }));
  const adjustments: PlanAdjustment[] = [];
  const genIndexes = scenes.flatMap((s, i) => (s.requiresGeneratedVideo ? [i] : []));
  const [protectedIndex, ...candidates] = genIndexes;

  for (const index of candidates.reverse()) {
    if (total <= max) break;
    const scene = scenes[index];
    if (!scene) continue;
    const excess = total - max;
    const from = scene.estimatedGenerationSeconds;
    if (from - excess >= MIN_GENERATED_SECONDS_PER_SCENE) {
      scene.estimatedGenerationSeconds = from - excess;
      total -= excess;
      adjustments.push({
        sceneId: scene.id,
        kind: "reduced_generation_seconds",
        fromSeconds: from,
        toSeconds: scene.estimatedGenerationSeconds,
        message: `Cena ${scene.order + 1}: vídeo IA reduzido de ${from}s para ${scene.estimatedGenerationSeconds}s; o restante usa movimento sobre o último quadro`,
      });
    } else {
      scenes[index] = toProductImage(scene);
      total -= from;
      adjustments.push({
        sceneId: scene.id,
        kind: "converted_to_product_image",
        fromSeconds: from,
        toSeconds: 0,
        message: `Cena ${scene.order + 1}: vídeo IA (${from}s) trocado por imagem do produto com movimento`,
      });
    }
  }

  const hook = protectedIndex === undefined ? undefined : scenes[protectedIndex];
  if (total > max && hook) {
    const from = hook.estimatedGenerationSeconds;
    hook.estimatedGenerationSeconds = Math.max(0.5, from - (total - max));
    total = max;
    adjustments.push({
      sceneId: hook.id,
      kind: "reduced_generation_seconds",
      fromSeconds: from,
      toSeconds: hook.estimatedGenerationSeconds,
      message: `Cena ${hook.order + 1}: vídeo IA reduzido de ${from}s para ${hook.estimatedGenerationSeconds}s`,
    });
  }

  return { plan: CreativePlanSchema.parse({ ...plan, scenes }), adjustments };
}

function normalizeHook(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Revisão completa da campanha: avalia, ajusta deterministicamente o que excede o preset
 * e reavalia. Nunca devolve criativo acima do máximo de segundos de IA.
 */
export function reviewCampaignPlan(
  campaign: CampaignPlan,
  settings: QualitySettings,
  pricing: MediaPricing,
  exchangeRate: number,
): { plan: CampaignPlan; reviews: CreativeReview[] } {
  const hookCounts = new Map<string, number>();
  for (const c of campaign.creatives) {
    const key = normalizeHook(c.hook);
    hookCounts.set(key, (hookCounts.get(key) ?? 0) + 1);
  }

  const reviews: CreativeReview[] = [];
  const creatives = campaign.creatives.map((creative) => {
    const original = evaluatePlanAgainstPreset(creative, settings, pricing, exchangeRate);
    const { plan: fitted, adjustments } = fitPlanToPreset(creative, settings);
    const final = evaluatePlanAgainstPreset(fitted, settings, pricing, exchangeRate);
    if ((hookCounts.get(normalizeHook(creative.hook)) ?? 0) > 1) {
      final.warnings.push({ code: "DUPLICATE_HOOKS", message: "Hook repetido em outro criativo da campanha" });
    }
    reviews.push({ creativeId: creative.id, original, adjustments, final });
    return fitted;
  });

  return {
    plan: { ...campaign, creatives, concepts: creatives.map((c) => c.concept) },
    reviews,
  };
}
