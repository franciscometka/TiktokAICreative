import type { ExecutionStage } from "@/domain/execution";
import type { Campaign, GenerationJob } from "@/domain/pipeline";

/**
 * Lote 7 (D103): ponto ÚNICO onde o PipelineService decide ONDE o trabalho pesado roda.
 * - Sem dispatcher (local/dev, testes): no próprio processo, como sempre (`activeJobs`).
 * - Com dispatcher (cloud): a ação do usuário só PERSISTE a tarefa na fila durável e volta;
 *   o worker executa a mesma descrição (`JobRun`) chamando `runJobTask`/`runPlanningTask`.
 *
 * `JobRun` é serializável (vai para `job_queue.payload`): nada de closures.
 */
export type JobRun =
  | { kind: "authorized" }
  | { kind: "hybrid_stage"; stage: ExecutionStage; regenerate?: boolean; sceneId?: string; thenFreeRender?: boolean }
  | { kind: "hybrid_mocks" }
  | { kind: "continue" }
  | { kind: "render" }
  | { kind: "narration_regen"; previousStatus: "completed" | "audio_review" };

export interface WorkDispatcher {
  /** Idempotente por chave: uma tarefa ativa por campanha/job (clique duplo não duplica). */
  /** `realAuthorized` = a etapa de planejamento REAL foi aprovada explicitamente (uma chamada). */
  enqueuePlanning(campaign: Campaign, realAuthorized: boolean): Promise<void>;
  enqueueJob(job: Pick<GenerationJob, "id" | "campaignId" | "stageModes">, run: JobRun): Promise<void>;
}

/** Execuções ativas conhecidas fora deste processo (fila durável): queued/running. */
export interface ActivitySnapshot {
  isActive(key: string): boolean;
  /** L8.6 (só leitura): ainda na fila × já assumida por um worker. undefined = não informado. */
  state?(key: string): ActiveState | undefined;
}

export type ActiveState = "queued" | "running";

export const planningKey = (campaignId: string) => `planning:${campaignId}`;
export const jobKey = (jobId: string) => `job:${jobId}`;

/**
 * Tarefa que PODE fazer chamada paga. Na retomada após queda do worker, tarefa paga com
 * operação em voo nunca é reexecutada sozinha (vira `blocked`). Render e mocks são grátis.
 */
export function isPaidRun(run: JobRun | { kind: "planning"; real: boolean }, job?: Pick<GenerationJob, "stageModes">): boolean {
  switch (run.kind) {
    case "planning": return run.real;
    case "render": return false;
    case "hybrid_mocks": return false;
    case "hybrid_stage": return run.stage !== "render" && job?.stageModes?.[run.stage] === "real";
    default: return true;
  }
}

/** Lock entre processos (Postgres advisory lock no cloud; mutex em memória no local). */
export interface CampaignLocks {
  run<T>(key: string, fn: () => Promise<T>): Promise<T>;
}
