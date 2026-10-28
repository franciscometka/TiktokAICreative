import type { BudgetExceededDecision } from "./cost";
import type { PreflightCheck } from "./readiness";
import { z } from "zod";

/** ugc_reference/ugc_video: rota AI UGC (Lote 5.3), separada de avatar (Presenter). */
export const EXECUTION_STAGES = ["planning", "narration", "scenes", "avatar", "ugc_reference", "ugc_video", "render"] as const;
export const ExecutionStageSchema = z.enum(EXECUTION_STAGES);
export type ExecutionStage = z.infer<typeof ExecutionStageSchema>;
export const ExecutionModeSchema = z.enum(["mock", "real"]);
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;
export const StageModesSchema = z.object({
  planning: ExecutionModeSchema.default("mock"), narration: ExecutionModeSchema.default("mock"),
  scenes: ExecutionModeSchema.default("mock"), avatar: ExecutionModeSchema.default("mock"),
  ugc_reference: ExecutionModeSchema.default("mock"), ugc_video: ExecutionModeSchema.default("mock"), render: ExecutionModeSchema.default("mock"),
});
export type StageModes = z.infer<typeof StageModesSchema>;
export const MOCK_STAGE_MODES: StageModes = { planning: "mock", narration: "mock", scenes: "mock", avatar: "mock", ugc_reference: "mock", ugc_video: "mock", render: "mock" };
export interface StageAvailability { available: boolean; reason?: string; provider: string }
export type StageCapabilities = Record<ExecutionStage, StageAvailability>;
export interface StageQuote {
  budgetDecision?: BudgetExceededDecision; regenerate?: boolean; repeat?: StageQuote;
  stage: ExecutionStage; mode: ExecutionMode; unit: string; token: string;
  provider: string; model: string; estimatedBrl: number; actualBrl: number; simulatedBrl: number;
  ready: boolean; blocked?: string; done: boolean; state: string;
  preflight?: PreflightCheck[];
  /** AI UGC: a etapa terminou e espera a decisão visual do usuário (aprovar a referência). Não é erro. */
  awaitingReview?: boolean;
}

export interface JobQuote {
  jobId: string;
  token: string;
  estimatedBrl: number;
  maximumAuthorizedBrl: number;
  actualBrl: number;
  ready: boolean;
  blocked?: string;
  stages: StageQuote[];
  /** Readiness geral: etapa que bloqueia o fluxo agora, com motivo. */
  blockingStage?: { stage: ExecutionStage; reason: string };
}
