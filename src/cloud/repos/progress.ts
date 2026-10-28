import type { GenerationJob } from "@/domain/pipeline";

/**
 * Progresso persistido (coluna `jobs.progress_stage`) para o frontend consultar por polling.
 * Derivado do documento do job — nunca inventado. "uploading" e "blocked" são marcados pelo
 * worker e voltam ao valor derivado na próxima gravação do job.
 */
export const PROGRESS_STAGES = [
  "planning", "awaiting_approval", "reference", "awaiting_reference_approval", "video_generation",
  "rendering", "uploading", "completed", "failed", "blocked", "cancelled",
] as const;
export type ProgressStage = (typeof PROGRESS_STAGES)[number];

export function progressStageOf(job: GenerationJob): ProgressStage {
  if (job.status === "cancelled") return "cancelled";
  if (job.status === "failed") return "failed";
  if (job.status === "completed") return "completed";
  if (job.waitingForStage === "ugc_reference") return "awaiting_reference_approval";
  if (job.status === "rendering" || job.currentStage === "render") return "rendering";
  if (job.status === "planned" || job.status === "cost_estimated" || job.status === "awaiting_approval" || job.status === "budget_exceeded" || job.status === "audio_review") return "awaiting_approval";
  if (job.currentStage === "ugc_reference") return "reference";
  return "video_generation";
}

// L8.5: movida sem alteração para @/pipeline/paid-operation (o view model também lê). Mesmo comportamento.
export { paidOperationInFlight } from "@/pipeline/paid-operation";
