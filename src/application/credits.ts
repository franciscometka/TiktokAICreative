import type { CostCategory, GenerationCost } from "@/domain/cost";
import {
  actualCreditsFromBrlSum, apportion, creditsBalance, dayKey, estimatedCreditsFromBrl, formatCredits, inPeriod, monthPeriod, periodDays, toMicroBrl,
  type CreditsConfig, type CreditsPeriod, type CreditsState,
} from "@/costs/credits";
import type { AppDeps } from "./campaign-actions";
import type { V2EstimateView } from "./create-v2";

/**
 * L8.2 — visão de créditos para a tela Créditos, a sidebar e a topbar. DERIVADA do ledger
 * (`ledger_entries` / data/ledger.jsonl): nenhuma tabela de saldo, nenhum débito gravado.
 *   uso do mês   = Σ custo REAL (não simulado) do mês × CREDITS_PER_BRL
 *   saldo        = max(0, franquia − uso)      excedente = max(0, uso − franquia)
 * Só dados de UX: sem prompt, provider, modelo, token ou ID técnico além do projeto (para o link).
 */

/** Nome de produto por grupo; categorias técnicas parecidas viram um só serviço. */
export const CREDIT_GROUPS = [
  { id: "video", label: "Vídeo IA", categories: ["video", "ugc_scene", "broll"] },
  { id: "reference", label: "Referência visual", categories: ["ugc_reference"] },
  { id: "planning", label: "Planejamento IA", categories: ["llm"] },
  { id: "audio", label: "Áudio", categories: ["audio"] },
  { id: "render", label: "Renderização", categories: ["rendering"] },
] as const satisfies readonly { id: string; label: string; categories: readonly CostCategory[] }[];
export type CreditGroupId = (typeof CREDIT_GROUPS)[number]["id"];

export function creditGroupOf(category: CostCategory): (typeof CREDIT_GROUPS)[number] {
  return CREDIT_GROUPS.find((g) => (g.categories as readonly CostCategory[]).includes(category)) ?? CREDIT_GROUPS[0];
}

/** Mínimo de vídeos reais de 30s para usar a média real no "≈ N vídeos" (senão: estimativa atual). */
export const MIN_VIDEOS_FOR_AVERAGE = 3;
/** Quantos vídeos recentes entram na média. */
export const AVERAGE_WINDOW = 10;
export const RECENT_LIMIT = 20;

export interface ProjectCreditInfo {
  campaignId: string;
  name: string;
  targetSeconds: number | null;
  /** Fim do render REAL concluído mais recente (null = sem vídeo real). */
  videoCompletedAt: string | null;
  active: boolean;
}

export interface CreditsView {
  configured: true;
  creditsPerBrl: number;
  allowance: number;
  used: number;
  remaining: number;
  overage: number;
  state: CreditsState;
  /** Custo real do mês em BRL (sistema interno). */
  usedBrl: number;
  period: CreditsPeriod;
  videosGenerated: number;
  /** null = sem base confiável (a UI não mostra a equivalência). */
  estimatedVideos: { seconds: 30; count: number; creditsPerVideo: number; basis: "average" | "estimate" } | null;
  usageByService: { id: CreditGroupId; label: string; credits: number; share: number }[];
  dailyUsage: { date: string; credits: number }[];
  recent: {
    projectId: string;
    name: string;
    kind: string;
    credits: number;
    at: string;
    breakdown: { label: string; credits: number }[];
  }[];
}

export type CreditsResult = CreditsView | { configured: false };

function grouped<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) map.set(key(item), [...(map.get(key(item)) ?? []), item]);
  return map;
}

function kindOf(project: ProjectCreditInfo | undefined, entries: readonly GenerationCost[], period: CreditsPeriod): string {
  if (project?.videoCompletedAt && inPeriod(project.videoCompletedAt, period)) return "Vídeo completo";
  if (project?.active) return "Em produção";
  if (entries.every((e) => e.category === "llm")) return "Roteiro";
  return "Geração parcial";
}

/** Créditos por grupo de serviço, repartidos para somar exatamente `total`. */
function byGroup(entries: readonly GenerationCost[], total: number): { id: CreditGroupId; label: string; credits: number }[] {
  const micro = CREDIT_GROUPS.map((g) => entries.filter((e) => creditGroupOf(e.category).id === g.id).reduce((a, e) => a + toMicroBrl(e.costBrl), 0));
  const parts = apportion(micro, total);
  return CREDIT_GROUPS.map((g, i) => ({ id: g.id, label: g.label, credits: parts[i]! })).filter((g) => g.credits > 0);
}

/** Pura: monta a visão a partir das entradas do ledger + informações dos projetos. */
export function buildCreditsView(input: {
  config: CreditsConfig;
  entries: readonly GenerationCost[];
  projects: readonly ProjectCreditInfo[];
  estimates: readonly V2EstimateView[];
  now: Date;
}): CreditsView {
  const { config, now } = input;
  const period = monthPeriod(now, config.timeZone);
  const real = input.entries.filter((e) => !e.simulated);
  const month = real.filter((e) => inPeriod(e.createdAt, period));

  const used = actualCreditsFromBrlSum(month.map((e) => e.costBrl), config.perBrl);
  const balance = creditsBalance(used, config.monthlyAllowance);
  const usedBrl = Math.round(month.reduce((a, e) => a + toMicroBrl(e.costBrl), 0) / 10_000) / 100;

  const services = byGroup(month, used);
  const usageByService = services.sort((a, b) => b.credits - a.credits).map((s) => ({ ...s, share: used > 0 ? s.credits / used : 0 }));

  const days = periodDays(period, now);
  const dayMicro = days.map((d) => month.filter((e) => dayKey(e.createdAt, config.timeZone) === d).reduce((a, e) => a + toMicroBrl(e.costBrl), 0));
  const dayParts = apportion(dayMicro, used);
  const dailyUsage = used > 0 ? days.map((date, i) => ({ date, credits: dayParts[i]! })) : [];

  const projects = new Map(input.projects.map((p) => [p.campaignId, p]));
  const recent = [...grouped(month, (e) => e.campaignId)].map(([projectId, entries]) => {
    const credits = actualCreditsFromBrlSum(entries.map((e) => e.costBrl), config.perBrl);
    const project = projects.get(projectId);
    return {
      projectId, name: project?.name ?? "Projeto removido", kind: kindOf(project, entries, period), credits,
      at: entries.map((e) => e.createdAt).sort().at(-1)!,
      breakdown: byGroup(entries, credits).map(({ label, credits: c }) => ({ label, credits: c })),
    };
  }).filter((r) => r.credits > 0).sort((a, b) => b.at.localeCompare(a.at)).slice(0, RECENT_LIMIT);

  const videosGenerated = input.projects.filter((p) => p.videoCompletedAt && inPeriod(p.videoCompletedAt, period)).length;

  return {
    configured: true, creditsPerBrl: config.perBrl, ...balance, usedBrl, period, videosGenerated,
    estimatedVideos: estimatedVideos(input, balance.remaining, real),
    usageByService, dailyUsage, recent,
  };
}

/**
 * "≈ N vídeos de 30s" honesto: 1) média REAL dos vídeos de 30s recentes (≥ MIN_VIDEOS_FOR_AVERAGE);
 * 2) senão, a estimativa atual de 30s (qualidade padrão) se não for provisória; 3) senão, null.
 * Custo por vídeo arredondado para cima (projeção nunca promete mais vídeos do que cabem).
 */
function estimatedVideos(input: { config: CreditsConfig; projects: readonly ProjectCreditInfo[]; estimates: readonly V2EstimateView[] }, remaining: number, real: readonly GenerationCost[]): CreditsView["estimatedVideos"] {
  const { config } = input;
  const byProject = grouped(real, (e) => e.campaignId);
  const samples = input.projects
    .filter((p) => p.videoCompletedAt && p.targetSeconds === 30 && byProject.has(p.campaignId))
    .sort((a, b) => b.videoCompletedAt!.localeCompare(a.videoCompletedAt!))
    .slice(0, AVERAGE_WINDOW)
    .map((p) => actualCreditsFromBrlSum(byProject.get(p.campaignId)!.map((e) => e.costBrl), config.perBrl))
    .filter((c) => c > 0);
  let perVideo: number | null = null;
  let basis: "average" | "estimate" = "average";
  if (samples.length >= MIN_VIDEOS_FOR_AVERAGE) {
    perVideo = Math.ceil(samples.reduce((a, c) => a + c, 0) / samples.length);
  } else {
    const estimate = input.estimates.find((e) => e.duration === 30 && e.quality === "high");
    if (estimate && !estimate.provisional && estimate.totalBrl > 0) {
      perVideo = estimatedCreditsFromBrl(estimate.totalBrl, config.perBrl);
      basis = "estimate";
    }
  }
  if (!perVideo || perVideo <= 0) return null;
  return { seconds: 30, count: Math.floor(remaining / perVideo), creditsPerVideo: perVideo, basis };
}

/** Lê ledger + projetos pelo service (local e cloud usam o MESMO código). */
export async function loadCreditsView(deps: Pick<AppDeps, "service">, config: CreditsConfig | null, estimates: readonly V2EstimateView[], now = new Date()): Promise<CreditsResult> {
  if (!config) return { configured: false };
  const { service } = deps;
  const entries = await service.listCostEntries();
  const projects: ProjectCreditInfo[] = [];
  for (const id of await service.listCampaignIds()) {
    try {
      const campaign = await service.getCampaign(id);
      const jobs = await service.listJobs(id);
      const done = jobs.flatMap((j) => j.renders.filter((r) => r.status === "completed" && !r.isMock).map((r) => r.finishedAt ?? r.startedAt)).sort().at(-1) ?? null;
      projects.push({
        campaignId: id,
        name: campaign.request.projectName || campaign.request.product.name,
        targetSeconds: campaign.request.targetDurationSeconds ?? null,
        videoCompletedAt: done,
        active: jobs.some((j) => service.isJobActive(j.id)),
      });
    } catch {
      // Projeto ilegível: o custo dele continua contando no uso (vem do ledger), só sem nome.
    }
  }
  return buildCreditsView({ config, entries, projects, estimates, now });
}

/** Resumo leve para sidebar/topbar. */
export interface CreditsSummary {
  /** L8.5: fator de conversão (a tela do projeto converte custo real/estimado sem outra consulta). */
  creditsPerBrl: number;
  remaining: number;
  allowance: number;
  state: CreditsState;
  estimatedVideos: CreditsView["estimatedVideos"];
}

/** "≈ 5 vídeos de 30s" — só com base confiável e saldo para ao menos 1 vídeo. */
export function videosLabel(summary: Pick<CreditsSummary, "estimatedVideos">): string | null {
  const e = summary.estimatedVideos;
  if (!e || e.count <= 0) return null;
  return `≈ ${formatCredits(e.count)} ${e.count === 1 ? "vídeo" : "vídeos"} de ${e.seconds}s`;
}

export function creditsSummary(view: CreditsResult): CreditsSummary | null {
  if (!view.configured) return null;
  return { creditsPerBrl: view.creditsPerBrl, remaining: view.remaining, allowance: view.allowance, state: view.state, estimatedVideos: view.estimatedVideos };
}
