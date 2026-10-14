import type { CampaignStatus, JobStatus } from "@/domain/pipeline";

export class InvalidTransitionError extends Error {
  override name = "InvalidTransitionError";
}

/**
 * Transições permitidas do job (um por criativo).
 * Não existe caminho de planned/cost_estimated direto para generating:
 * geração SEMPRE passa por awaiting_approval + aprovação válida (ver guards.ts).
 */
export const JOB_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  planned: ["cost_estimated", "cancelled"],
  cost_estimated: ["cost_estimated", "awaiting_approval", "cancelled"],
  // voltar para cost_estimated = plano/preço mudou → nova estimativa invalida a aprovação
  awaiting_approval: ["generating", "cost_estimated", "cancelled"],
  // generating → completed: regeneração de cena falhou e o vídeo anterior foi mantido
  // generating → audio_review: narração real muito mais longa que o planejado (decisão explícita)
  generating: ["rendering", "budget_exceeded", "audio_review", "failed", "cancelled", "completed"],
  budget_exceeded: ["generating", "cancelled"],
  // aceitar (renderiza com o fim estendido) | gerar a narração de novo (paga, explícita) | cancelar
  audio_review: ["rendering", "generating", "cancelled"],
  rendering: ["completed", "failed"],
  // completed → generating: regeneração explícita de cena (com checagem de orçamento)
  // completed → rendering: "Renderizar novamente" (nova versão; render local não tem chamada paga)
  completed: ["generating", "rendering"],
  // após falha: nunca retomar sozinho; mídia paga exige nova estimativa e nova aprovação.
  // failed → rendering: só re-render explícito com toda a mídia já gerada (guard mediaComplete)
  failed: ["cost_estimated", "cancelled", "rendering"],
  cancelled: [],
};

export const CAMPAIGN_TRANSITIONS: Readonly<Record<CampaignStatus, readonly CampaignStatus[]>> = {
  draft: ["planning"],
  planning: ["planned", "failed"],
  planned: [],
  failed: ["planning"],
};

export function canTransitionJob(from: JobStatus, to: JobStatus): boolean {
  return JOB_TRANSITIONS[from].includes(to);
}

export function canTransitionCampaign(from: CampaignStatus, to: CampaignStatus): boolean {
  return CAMPAIGN_TRANSITIONS[from].includes(to);
}

export function transitionJob<T extends { status: JobStatus; updatedAt: string }>(
  job: T,
  to: JobStatus,
  now: string,
): T {
  if (!canTransitionJob(job.status, to)) {
    throw new InvalidTransitionError(`Job: transição inválida ${job.status} → ${to}`);
  }
  return { ...job, status: to, updatedAt: now };
}

export function transitionCampaign<T extends { status: CampaignStatus; updatedAt: string }>(
  campaign: T,
  to: CampaignStatus,
  now: string,
): T {
  if (!canTransitionCampaign(campaign.status, to)) {
    throw new InvalidTransitionError(`Campanha: transição inválida ${campaign.status} → ${to}`);
  }
  return { ...campaign, status: to, updatedAt: now };
}
