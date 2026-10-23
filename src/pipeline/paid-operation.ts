import type { GenerationJob } from "@/domain/pipeline";

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
