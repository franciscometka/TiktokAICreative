import type { Campaign, GenerationJob, JobStatus } from "@/domain/pipeline";
import { paidOperationInFlight } from "@/pipeline/paid-operation";

/**
 * L8.8.1 — "fatos" mínimos de um projeto: o que o status do card, o shell (palette + eventos) e o
 * resumo de créditos precisam — e nada mais (sem cenas, mídia, prompts ou ledger detalhado).
 * - Local: extraídos dos documentos (`projectFactsOf`).
 * - Cloud: UMA consulta SQL que extrai os mesmos campos dentro do banco (o documento não sai de lá).
 * O status do projeto sai SEMPRE de `statusFromFacts` (única regra; `projectStatus` delega para cá).
 */

export interface ProjectFacts {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  campaignStatus: Campaign["status"];
  /** Rascunho que nunca iniciou o planejamento (aguarda a aprovação explícita). */
  neverStarted: boolean;
  targetSeconds: number | null;
  job: {
    id: string;
    status: JobStatus;
    updatedAt: string;
    waitingForStage: boolean;
    authorizationPaused: boolean;
    lastAttemptFailed: boolean;
    paidOperationInFlight: boolean;
    /** Último render concluído (real OU simulado). */
    lastRender: { id: string; isMock: boolean; durationSeconds: number | null } | null;
    /** Fim do último render REAL concluído (créditos: "vídeo completo"). */
    realVideoCompletedAt: string | null;
  } | null;
}

export interface ProjectActivity {
  planningActive: boolean;
  planningQueued: boolean;
  jobActive: boolean;
  jobQueued: boolean;
}

export function projectFactsOf(campaign: Campaign, job: GenerationJob | undefined): ProjectFacts {
  const lastRender = job?.renders.findLast((r) => r.status === "completed");
  const realDone = job?.renders.filter((r) => r.status === "completed" && !r.isMock).map((r) => r.finishedAt ?? r.startedAt).sort().at(-1) ?? null;
  return {
    id: campaign.id,
    name: campaign.request.projectName || campaign.request.product.name,
    createdAt: campaign.createdAt,
    updatedAt: campaign.updatedAt,
    campaignStatus: campaign.status,
    neverStarted: campaign.status === "draft" && campaign.planningRuns === undefined && !campaign.planningStartedAt,
    targetSeconds: campaign.request.targetDurationSeconds ?? null,
    job: job ? {
      id: job.id,
      status: job.status,
      updatedAt: job.updatedAt,
      waitingForStage: !!job.waitingForStage,
      authorizationPaused: job.jobAuthorization?.status === "paused",
      lastAttemptFailed: job.scenes.some((s) => s.attempts.at(-1)?.status === "failed"),
      paidOperationInFlight: !!paidOperationInFlight(job),
      // id da EXECUÇÃO do render (único por versão gerada).
      lastRender: lastRender ? { id: lastRender.id, isMock: lastRender.isMock, durationSeconds: lastRender.durationSeconds ?? null } : null,
      realVideoCompletedAt: realDone,
    } : null,
  };
}

export type FactsStatus = "awaiting_approval" | "queued" | "preparing" | "generating" | "attention" | "ready" | "failed" | "blocked" | "simulated";

const AWAITING_JOB: readonly JobStatus[] = ["planned", "cost_estimated", "awaiting_approval", "budget_exceeded"];

/** ÚNICA regra de status honesto do projeto (L8.6), agora sobre os fatos. */
export function statusFromFacts(f: ProjectFacts, a: ProjectActivity): FactsStatus {
  if (f.campaignStatus === "draft" || f.campaignStatus === "planning") {
    if (a.planningActive) return a.planningQueued ? "queued" : "preparing";
    return f.neverStarted ? "awaiting_approval" : "failed";
  }
  if (f.campaignStatus === "failed") return "failed";
  const job = f.job;
  if (!job) return "awaiting_approval";
  if (a.jobActive) return a.jobQueued ? "queued" : "generating";
  if (job.status === "completed" && job.lastRender) return job.lastRender.isMock ? "simulated" : "ready";
  // Em geração sem execução: com operação paga sem confirmação = pausa de segurança; senão, falha.
  if ((job.status === "generating" || job.status === "rendering") && !job.waitingForStage) return job.paidOperationInFlight ? "blocked" : "failed";
  if (job.status === "failed" || job.status === "cancelled" || job.lastAttemptFailed) return "failed";
  if (job.waitingForStage || job.authorizationPaused || job.status === "audio_review") return "attention";
  if (AWAITING_JOB.includes(job.status)) return "awaiting_approval";
  return "attention";
}

/**
 * Identidade DURÁVEL do episódio, vinda do servidor (nunca do relógio do cliente):
 * pronto = id do render; demais estados = momento da última gravação do job (ou da campanha).
 * Pronto v1 → v2 = dois episódios; falhou → recuperou → falhou = dois episódios.
 */
export function episodeOf(f: ProjectFacts, status: FactsStatus): string {
  if ((status === "ready" || status === "simulated") && f.job?.lastRender) return `render-${f.job.lastRender.id}`;
  return `at-${f.job?.updatedAt ?? f.updatedAt}`;
}

/** Janela do shell: TODO projeto em produção/aguardando ação (até `active`) + os mais recentemente atualizados. */
export const SHELL_WINDOW = { active: 50, recent: 20 } as const;
const OPEN: readonly FactsStatus[] = ["awaiting_approval", "queued", "preparing", "generating", "attention", "blocked"];

export function shellWindow<T extends { status: FactsStatus; updatedAt: string; id: string }>(items: readonly T[], limits: { active: number; recent: number } = SHELL_WINDOW): T[] {
  const byUpdated = [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  const open = byUpdated.filter((p) => OPEN.includes(p.status)).slice(0, limits.active);
  const chosen = new Set(open.map((p) => p.id));
  const recent = byUpdated.filter((p) => !chosen.has(p.id)).slice(0, limits.recent);
  return [...open, ...recent];
}

/** "Atualizado em" do projeto = a gravação mais recente (campanha ou job). */
export function factsUpdatedAt(f: ProjectFacts): string {
  return f.job && f.job.updatedAt > f.updatedAt ? f.job.updatedAt : f.updatedAt;
}
