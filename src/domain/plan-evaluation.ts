import { z } from "zod";
import { RangeSchema } from "./quality";

const nonEmpty = z.string().trim().min(1);

export const PLAN_ISSUE_CODES = [
  "GENERATED_SECONDS_ABOVE_PRESET",
  "GENERATED_SECONDS_BELOW_PRESET",
  "FINAL_DURATION_OUT_OF_RANGE",
  "NO_GENERATED_VIDEO",
  "DUPLICATE_HOOKS",
] as const;
export const PlanIssueCodeSchema = z.enum(PLAN_ISSUE_CODES);
export type PlanIssueCode = z.infer<typeof PlanIssueCodeSchema>;

export const PlanIssueSchema = z.object({ code: PlanIssueCodeSchema, message: nonEmpty });
export type PlanIssue = z.infer<typeof PlanIssueSchema>;

/** Ajuste determinístico aplicado pelo sistema (não pelo LLM) para caber no preset. */
export const PlanAdjustmentSchema = z.object({
  sceneId: nonEmpty,
  kind: z.enum(["converted_to_product_image", "reduced_generation_seconds"]),
  fromSeconds: z.number().nonnegative(),
  toSeconds: z.number().nonnegative(),
  message: nonEmpty,
});
export type PlanAdjustment = z.infer<typeof PlanAdjustmentSchema>;

export const PlanEvaluationSchema = z.object({
  creativeId: nonEmpty,
  /** false = viola limite rígido (ex.: segundos de IA acima do máximo). */
  valid: z.boolean(),
  generatedSeconds: z.number().nonnegative(),
  allowedGeneratedSeconds: RangeSchema,
  finalSeconds: z.number().nonnegative(),
  allowedFinalSeconds: RangeSchema,
  errors: z.array(PlanIssueSchema),
  warnings: z.array(PlanIssueSchema),
  /** Custo FUTURO estimado (vídeo+áudio+render) do plano avaliado, em BRL. */
  estimatedFutureCostBrl: z.number().nonnegative(),
});
export type PlanEvaluation = z.infer<typeof PlanEvaluationSchema>;

/** Resultado da revisão de um criativo: avaliação original, ajustes e avaliação final. */
export const CreativeReviewSchema = z.object({
  creativeId: nonEmpty,
  original: PlanEvaluationSchema,
  adjustments: z.array(PlanAdjustmentSchema),
  final: PlanEvaluationSchema,
});
export type CreativeReview = z.infer<typeof CreativeReviewSchema>;
