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

/**
 * Operação PAGA possivelmente em voo segundo o próprio documento (marcadores gravados ANTES do
 * POST): intenção de etapa "running", operação Veo/Krea não liquidada, presenter/vídeo em envio.
 * Usado na retomada após queda do worker: se houver, a tarefa vira `blocked` (incerta) e nada
 * é reenviado automaticamente.
 */
export function paidOperationInFlight(job: GenerationJob): string | undefined {
  const intent = job.stageIntents?.find((i) => i.state === "running");
  if (intent) return `etapa ${intent.stage} iniciada (${intent.unit}) sem confirmação`;
  const reference = job.ugc?.references.find((r) => !r.isMock && (r.state === "submitting" || r.state === "pending" || r.state === "uncertain"));
  if (reference) return `referência UGC ${reference.version} ${reference.state} sem confirmação`;
  const op = job.ugcVideoOperations?.find((o) => o.state !== "settled");
  if (op) return `operação de vídeo UGC ${op.state} sem confirmação`;
  const presenter = job.presenterTasks?.find((t) => t.state === "pending" || t.state === "submitting");
  if (presenter) return "presenter enviado sem confirmação";
  const video = job.videoTasks?.find((t) => t.state === "submitting" || t.state === "pending");
  if (video) return "vídeo enviado sem confirmação";
  return undefined;
}
