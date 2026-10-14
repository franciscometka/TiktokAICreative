import { z } from "zod";
import {
  CreativeConceptSchema,
  CreativePlanDraftSchema,
  CreativePlanSchema,
  CreativeStyleSchema,
} from "./creative";
import { ProductInputSchema } from "./product";

const nonEmpty = z.string().trim().min(1);

export const ProductAnalysisSchema = z.object({
  summary: nonEmpty,
  targetAudiences: z.array(nonEmpty).min(1),
  /** Dores/problemas que o produto resolve. */
  problemsSolved: z.array(nonEmpty).min(1),
  benefits: z.array(nonEmpty).min(1),
  differentiators: z.array(nonEmpty),
  sellingAngles: z.array(nonEmpty).min(1),
  objections: z.array(nonEmpty),
  /** Alegações que NÃO devem ser feitas (saúde, garantias, comparações sem prova...). */
  communicationRisks: z.array(nonEmpty),
  /** Informações que faltam e limitam o criativo (ex.: medidas, prova social). */
  missingInformation: z.array(nonEmpty),
});
export type ProductAnalysis = z.infer<typeof ProductAnalysisSchema>;

export const HookDraftSchema = z.object({
  text: nonEmpty,
  angle: nonEmpty,
  style: CreativeStyleSchema,
});
export type HookDraft = z.infer<typeof HookDraftSchema>;

export const HookSchema = HookDraftSchema.extend({ id: nonEmpty });
export type Hook = z.infer<typeof HookSchema>;

/** Saída do LLM para o planejamento de campanha (sem IDs). */
export const CampaignPlanDraftSchema = z.object({
  analysis: ProductAnalysisSchema,
  hooks: z.array(HookDraftSchema).min(1),
  creatives: z.array(CreativePlanDraftSchema).min(1),
});
export type CampaignPlanDraft = z.infer<typeof CampaignPlanDraftSchema>;

export const CampaignPlanSchema = z.object({
  product: ProductInputSchema,
  analysis: ProductAnalysisSchema,
  hooks: z.array(HookSchema).min(1),
  concepts: z.array(CreativeConceptSchema).min(1),
  creatives: z.array(CreativePlanSchema).min(1),
});
export type CampaignPlan = z.infer<typeof CampaignPlanSchema>;
