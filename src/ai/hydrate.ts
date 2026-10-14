import { CampaignPlanSchema, type CampaignPlan, type CampaignPlanDraft } from "@/domain/campaign";
import type { CreativePlan } from "@/domain/creative";
import type { ProductInput } from "@/domain/product";
import type { IdGenerator } from "@/lib/ids";

/**
 * Converte a saída do LLM (sem IDs) no modelo de domínio, atribuindo IDs e ordem.
 * O resultado é validado de novo pelo schema completo.
 */
export function hydrateCampaignPlan(
  draft: CampaignPlanDraft,
  product: ProductInput,
  ids: IdGenerator,
): CampaignPlan {
  const creatives: CreativePlan[] = draft.creatives.map((c) => ({
    id: ids("creative"),
    productId: product.id,
    concept: { ...c.concept, id: ids("concept") },
    duration: c.duration,
    hook: c.hook,
    script: c.script,
    callToAction: c.callToAction,
    scenes: c.scenes.map((s, order) => ({ ...s, id: ids("scene"), order })),
  }));

  return CampaignPlanSchema.parse({
    product,
    analysis: draft.analysis,
    hooks: draft.hooks.map((h) => ({ ...h, id: ids("hook") })),
    concepts: creatives.map((c) => c.concept),
    creatives,
  });
}
