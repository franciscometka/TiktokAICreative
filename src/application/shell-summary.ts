import { buildCreditsView, creditsSummary, type CreditsSummary, type ProjectCreditInfo } from "./credits";
import type { CreditsConfig } from "@/costs/credits";
import type { AppDeps } from "./campaign-actions";
import type { V2EstimateView } from "./create-v2";
import { episodeOf, factsUpdatedAt, projectFactsOf, shellWindow, statusFromFacts, type FactsStatus, type ProjectFacts } from "./project-facts";
import { PROJECT_STATUS_LABELS } from "./project-v2-view";
import { listAvatarViews, type AvatarDeps } from "./avatar-actions";

/**
 * L8.8.1 — leitura LEVE do shell (palette + eventos de UX + saldo). Custo constante por poll:
 * fatos dos projetos (1 leitura; no cloud, 1 SQL sem documentos) + ledger do mês (1) + avatares (1).
 * Sem N+1, sem cenas/mídia/documentos. A janela inclui TODO projeto em produção/aguardando ação
 * (mesmo antigo) + os mais recentemente atualizados — o fim de um projeto antigo ativo é observado.
 */

export interface ShellProject {
  id: string;
  name: string;
  status: FactsStatus;
  statusLabel: string;
  durationLabel: string | null;
  /** Identidade durável do estado atual (vinda do servidor): render id ou momento da gravação. */
  episode: string;
  updatedAt: string;
}

export interface ShellSummary {
  projects: ShellProject[];
  avatars: { id: string; name: string; active: boolean }[];
  credits: CreditsSummary | null;
}

type Service = AppDeps["service"];

/** Fatos de todos os projetos: consulta leve do store (cloud) ou extração dos documentos (local). */
export async function loadProjectFacts(service: Service): Promise<ProjectFacts[]> {
  const fast = await service.listProjectFactsFast();
  if (fast) return fast;
  const facts: ProjectFacts[] = [];
  for (const id of await service.listCampaignIds()) {
    try {
      const campaign = await service.getCampaign(id);
      facts.push(projectFactsOf(campaign, (await service.listJobs(id))[0]));
    } catch {
      // Projeto ilegível: continua acessível em Configurações → Diagnóstico.
    }
  }
  return facts;
}

function activityOf(service: Service, f: ProjectFacts) {
  return {
    planningActive: service.isPlanningActive(f.id),
    planningQueued: service.executionState({ campaignId: f.id }) === "queued",
    jobActive: f.job ? service.isJobActive(f.job.id) : false,
    jobQueued: f.job ? service.executionState({ jobId: f.job.id }) === "queued" : false,
  };
}

export function shellProjects(service: Service, facts: readonly ProjectFacts[]): ShellProject[] {
  const all = facts.map((f): ShellProject => {
    const status = statusFromFacts(f, activityOf(service, f));
    const seconds = f.job?.lastRender?.durationSeconds ?? f.targetSeconds;
    return { id: f.id, name: f.name, status, statusLabel: PROJECT_STATUS_LABELS[status], durationLabel: seconds ? `${Math.round(seconds)}s` : null, episode: episodeOf(f, status), updatedAt: factsUpdatedAt(f) };
  });
  return shellWindow(all);
}

/** Informações de projeto que os créditos usam, a partir dos MESMOS fatos (sem reler documentos). */
export function creditProjects(service: Service, facts: readonly ProjectFacts[]): ProjectCreditInfo[] {
  return facts.map((f) => ({ campaignId: f.id, name: f.name, targetSeconds: f.targetSeconds, videoCompletedAt: f.job?.realVideoCompletedAt ?? null, active: f.job ? service.isJobActive(f.job.id) : false }));
}

export async function buildShellSummary(deps: Pick<AppDeps, "service"> & AvatarDeps, config: CreditsConfig | null, estimates: readonly V2EstimateView[], now = new Date()): Promise<ShellSummary> {
  const { service } = deps;
  const [facts, entries, avatars] = await Promise.all([
    loadProjectFacts(service),
    config ? service.listCostEntries() : Promise.resolve([]),
    listAvatarViews(deps).catch(() => []),
  ]);
  return {
    projects: shellProjects(service, facts),
    avatars: avatars.map((a) => ({ id: a.id, name: a.name, active: a.active })),
    credits: config ? creditsSummary(buildCreditsView({ config, entries, projects: creditProjects(service, facts), estimates, now })) : null,
  };
}
