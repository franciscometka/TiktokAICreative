import { z } from "zod";
import { CampaignPlanSchema } from "./campaign";
import {
  BudgetExceededDecisionSchema,
  CostBudgetSchema,
  CostEstimateSchema,
  OverBudgetAuthorizationSchema,
} from "./cost";
import { CreativeStyleSchema } from "./creative";
import { CreativeReviewSchema } from "./plan-evaluation";
import { ProductInputSchema } from "./product";
import { GenerationQualitySchema, QualitySettingsSchema } from "./quality";
import { RenderManifestSchema } from "./render";

const nonEmpty = z.string().trim().min(1);

/**
 * Duas máquinas de estado:
 * - Campaign: planejamento (uma chamada de LLM gera vários criativos).
 * - GenerationJob: um por criativo; controla custo, aprovação e geração de mídia.
 * Transições permitidas em pipeline/states.ts.
 */

export const CAMPAIGN_STATUSES = ["draft", "planning", "planned", "failed"] as const;
export const CampaignStatusSchema = z.enum(CAMPAIGN_STATUSES);
export type CampaignStatus = z.infer<typeof CampaignStatusSchema>;

export const JOB_STATUSES = [
  "planned",
  "cost_estimated",
  "awaiting_approval",
  "generating",
  "budget_exceeded",
  "rendering",
  "completed",
  "failed",
  "cancelled",
] as const;
export const JobStatusSchema = z.enum(JOB_STATUSES);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const CampaignRequestSchema = z.object({
  product: ProductInputSchema,
  styles: z.array(CreativeStyleSchema).min(1),
  creativeCount: z.int().min(1).max(10),
  quality: GenerationQualitySchema,
  /** Obrigatório quando quality = "custom". */
  customSettings: QualitySettingsSchema.optional(),
  budget: CostBudgetSchema,
});
export type CampaignRequest = z.infer<typeof CampaignRequestSchema>;

export const CampaignSchema = z.object({
  id: nonEmpty,
  status: CampaignStatusSchema,
  request: CampaignRequestSchema,
  settings: QualitySettingsSchema,
  plan: CampaignPlanSchema.optional(),
  /** Avaliação de cada criativo contra o preset e ajustes determinísticos aplicados. */
  reviews: z.array(CreativeReviewSchema).optional(),
  /** Planner usado (ex.: "anthropic", "mock") — simulado ou real. */
  plannerId: z.string().optional(),
  jobIds: z.array(nonEmpty),
  error: z.string().optional(),
  createdAt: nonEmpty,
  updatedAt: nonEmpty,
});
export type Campaign = z.infer<typeof CampaignSchema>;

export const MediaKindSchema = z.enum(["video", "audio"]);
export type MediaKind = z.infer<typeof MediaKindSchema>;

/** Uma chamada a um provider. Toda tentativa fica registrada, inclusive as descartadas. */
export const MediaAttemptSchema = z.object({
  id: nonEmpty,
  kind: MediaKindSchema,
  sceneId: z.string().nullable(),
  attemptNumber: z.int().positive(),
  provider: nonEmpty,
  model: nonEmpty,
  providerJobId: z.string().nullable(),
  status: z.enum(["succeeded", "failed"]),
  /** Apenas a tentativa ativa entra no vídeo final; as demais são descartadas (mas custam). */
  active: z.boolean(),
  assetUri: z.string().optional(),
  durationSeconds: z.number().nonnegative().optional(),
  isMock: z.boolean(),
  error: z.string().optional(),
  createdAt: nonEmpty,
});
export type MediaAttempt = z.infer<typeof MediaAttemptSchema>;

export const SceneGenerationStateSchema = z.object({
  sceneId: nonEmpty,
  order: z.int().nonnegative(),
  requiresGeneratedVideo: z.boolean(),
  attempts: z.array(MediaAttemptSchema),
});
export type SceneGenerationState = z.infer<typeof SceneGenerationStateSchema>;

export const ApprovalSchema = z.object({
  /** A aprovação vale apenas para ESTA estimativa. Nova estimativa invalida a aprovação. */
  estimateId: nonEmpty,
  approvedTotalBrl: z.number().nonnegative(),
  approvedAt: nonEmpty,
  overBudget: z.boolean(),
});
export type Approval = z.infer<typeof ApprovalSchema>;

export const GenerationJobSchema = z.object({
  id: nonEmpty,
  campaignId: nonEmpty,
  creativeId: nonEmpty,
  status: JobStatusSchema,
  scenes: z.array(SceneGenerationStateSchema),
  audioAttempts: z.array(MediaAttemptSchema),
  estimate: CostEstimateSchema.optional(),
  approval: ApprovalSchema.optional(),
  overBudgetAuthorization: OverBudgetAuthorizationSchema.optional(),
  pendingBudgetDecision: BudgetExceededDecisionSchema.optional(),
  manifest: RenderManifestSchema.optional(),
  outputUri: z.string().optional(),
  error: z.string().optional(),
  createdAt: nonEmpty,
  updatedAt: nonEmpty,
});
export type GenerationJob = z.infer<typeof GenerationJobSchema>;
