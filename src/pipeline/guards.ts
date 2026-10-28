import type { GenerationJob, JobStatus, MediaAttempt } from "@/domain/pipeline";

/**
 * Guards PUROS chamados imediatamente antes de qualquer chamada paga.
 * Se lançam, a chamada não acontece.
 */

export class ApprovalRequiredError extends Error {
  override name = "ApprovalRequiredError";
}

export class StaleEstimateError extends Error {
  override name = "StaleEstimateError";
}

/**
 * O token enviado não é o da cotação atual do job. Nada foi autorizado; a cotação nova vem junto
 * para a tela mostrar e o usuário decidir com um NOVO clique (o token novo nunca autoriza sozinho).
 */
export interface RefreshedQuote { estimatedBrl: number; maximumAuthorizedBrl: number; token: string }
export class QuoteChangedError extends Error {
  override name = "QuoteChangedError";
  constructor(readonly quote: RefreshedQuote) {
    super("A estimativa mudou; revise o novo teto antes de gerar.");
  }
}

export class AttemptLimitReachedError extends Error {
  override name = "AttemptLimitReachedError";
}

export class UnexpectedStatusError extends Error {
  override name = "UnexpectedStatusError";
}

export function assertStatus(job: GenerationJob, ...allowed: JobStatus[]): void {
  if (!allowed.includes(job.status)) {
    throw new UnexpectedStatusError(`Job ${job.id} está em "${job.status}"; esperado: ${allowed.join(" | ")}`);
  }
}

/** A aprovação existe e corresponde EXATAMENTE à estimativa atual do job. */
export function assertApprovalValid(job: GenerationJob): void {
  if (!job.estimate) throw new ApprovalRequiredError(`Job ${job.id} não tem estimativa de custo`);
  if (!job.approval) throw new ApprovalRequiredError(`Job ${job.id} não foi aprovado pelo usuário`);
  if (job.approval.estimateId !== job.estimate.id) {
    throw new StaleEstimateError(`Aprovação do job ${job.id} refere-se a uma estimativa antiga`);
  }
}

/** Pré-condição de toda chamada paga de mídia. */
export function assertCanStartPaidCall(job: GenerationJob): void {
  assertStatus(job, "generating");
  assertApprovalValid(job);
}

export function assertAttemptsAvailable(attempts: readonly MediaAttempt[], maxAttempts: number): void {
  if (attempts.length >= maxAttempts) {
    throw new AttemptLimitReachedError(
      `Limite de ${maxAttempts} tentativas atingido (${attempts.length} já realizadas)`,
    );
  }
}

export function activeAttempt(attempts: readonly MediaAttempt[]): MediaAttempt | undefined {
  return attempts.find((a) => a.active && a.status === "succeeded");
}

/** IDs de tentativas cujo resultado NÃO está no vídeo final (descartadas ou falhas). */
export function discardedAttemptIds(job: GenerationJob): Set<string> {
  const all = [...job.scenes.flatMap((s) => s.attempts), ...job.audioAttempts];
  return new Set(all.filter((a) => !a.active).map((a) => a.id));
}

/** Todas as cenas com vídeo IA e a narração têm asset ativo: dá para (re)renderizar sem chamada paga. */
export function mediaComplete(job: GenerationJob): boolean {
  const scenesDone = job.scenes.every((s) => !s.requiresGeneratedVideo || activeAttempt(s.attempts) !== undefined);
  // AI UGC com fala nativa do vídeo: não existe narração TTS separada (D79).
  const narrationNeeded = job.ugc?.audioStrategy !== "native_speech";
  return scenesDone && (!narrationNeeded || activeAttempt(job.audioAttempts) !== undefined);
}
