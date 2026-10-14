import type { CostEstimate, CostLineItem, GenerationCost } from "@/domain/cost";
import type { GenerationJob, JobStatus } from "@/domain/pipeline";
import { activeAttempt } from "./guards";

/**
 * Funções PURAS que traduzem estado (jobs + ledger) em números para checkBudget().
 *
 * Convenções:
 * - O custo do planejamento (LLM) é registrado no nível da CAMPANHA (jobId = null).
 *   Na estimativa de cada criativo ele aparece em estimate.incurred (rateio do custo real).
 * - "Comprometido" de um job aprovado = gasto real + o que ainda falta da estimativa aprovada.
 */

const usdToBrl = (usd: number, estimate: CostEstimate) => usd * estimate.exchangeRate;

function isLineDone(line: CostLineItem, job: GenerationJob): boolean {
  switch (line.category) {
    case "video": {
      const scene = job.scenes.find((s) => s.sceneId === line.sceneId);
      return scene !== undefined && activeAttempt(scene.attempts) !== undefined;
    }
    case "audio":
      return activeAttempt(job.audioAttempts) !== undefined;
    case "rendering":
      return job.status === "completed" && job.outputUri !== undefined;
    case "llm":
      return true;
  }
}

/** Parcela REAL do planejamento atribuída ao criativo (já incorrida; não volta se cancelar). */
export function planningShareBrl(job: GenerationJob): number {
  return job.estimate?.incurred.llmCost.brl ?? 0;
}

/** Quanto da estimativa (geração + render) ainda não foi executado. */
export function remainingEstimateBrl(job: GenerationJob): number {
  const estimate = job.estimate;
  if (!estimate) return 0;
  const usd = estimate.breakdown
    .filter((l) => !isLineDone(l, job))
    .reduce((a, l) => a + l.subtotalUsd, 0);
  return usdToBrl(usd, estimate);
}

/** Estimativa (BRL) de gerar a narração de novo (nova versão, novo custo). */
export function narrationEstimateBrl(job: GenerationJob): number {
  const estimate = job.estimate;
  if (!estimate) return 0;
  const line = estimate.breakdown.find((l) => l.category === "audio");
  return line ? usdToBrl(line.subtotalUsd, estimate) : 0;
}

/** Estimativa (BRL) de regenerar o vídeo de uma cena. */
export function sceneEstimateBrl(job: GenerationJob, sceneId: string): number {
  const estimate = job.estimate;
  if (!estimate) return 0;
  const line = estimate.breakdown.find((l) => l.category === "video" && l.sceneId === sceneId);
  return line ? usdToBrl(line.subtotalUsd, estimate) : 0;
}

export function spentBrl(entries: readonly GenerationCost[], jobId: string): number {
  return entries.filter((e) => e.jobId === jobId).reduce((a, e) => a + e.costBrl, 0);
}

export function campaignLevelSpentBrl(entries: readonly GenerationCost[]): number {
  return entries.filter((e) => e.jobId === null).reduce((a, e) => a + e.costBrl, 0);
}

/** Status em que a estimativa aprovada ainda pode virar gasto. */
const COMMITTED_STATUSES: readonly JobStatus[] = ["awaiting_approval", "generating", "budget_exceeded", "rendering"];

export function jobCommitmentBrl(job: GenerationJob, entries: readonly GenerationCost[]): number {
  const spent = spentBrl(entries, job.id);
  const approved = job.approval !== undefined && COMMITTED_STATUSES.includes(job.status);
  return approved ? spent + remainingEstimateBrl(job) : spent;
}

export interface BudgetSnapshot {
  creativeCurrentBrl: number;
  campaignCurrentBrl: number;
}

/**
 * Valores "atuais" para checkBudget(), sem incluir a ação que se pretende executar.
 * - criativo: rateio do planejamento + gasto real deste job
 * - campanha: planejamento real + compromissos dos OUTROS jobs + gasto real deste job
 */
export function budgetSnapshot(
  job: GenerationJob,
  campaignJobs: readonly GenerationJob[],
  campaignEntries: readonly GenerationCost[],
): BudgetSnapshot {
  const ownSpent = spentBrl(campaignEntries, job.id);
  const others = campaignJobs
    .filter((j) => j.id !== job.id)
    .reduce((a, j) => a + jobCommitmentBrl(j, campaignEntries), 0);
  return {
    creativeCurrentBrl: planningShareBrl(job) + ownSpent,
    campaignCurrentBrl: campaignLevelSpentBrl(campaignEntries) + others + ownSpent,
  };
}
