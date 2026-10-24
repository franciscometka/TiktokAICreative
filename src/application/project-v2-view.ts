import type { Campaign, GenerationJob } from "@/domain/pipeline";
import { formatBrl } from "@/lib/money";
import type { AppDeps } from "./campaign-actions";
import { imagePreviewUrl, type CampaignView, type CreativeView } from "./campaign-view";
import { planningErrorDetails } from "./user-errors";
import { ugcReferenceUrl } from "./ugc-view";
import { projectFactsOf, statusFromFacts } from "./project-facts";

/**
 * Lote 6 — UX V2: a complexidade do pipeline continua existindo, mas a tela principal mostra só
 * o essencial (progresso em 4 passos, UMA ação por vez, erro curto, resultado). Tudo técnico
 * (providers, IDs, ledger, readiness, gerado × usado) fica em "Detalhes técnicos".
 */

export type ProgressState = "done" | "current" | "pending" | "error";
export interface ProgressStep { id: "script" | "presenter" | "video" | "finish"; label: string; state: ProgressState }

export type ProjectPhase =
  | "planning" | "planning_approval" | "planning_failed"
  | "ready_to_generate" | "presenter_review" | "product_check"
  | "generating" | "failed" | "done" | "simulated_done";

export interface ProjectV2View {
  phase: ProjectPhase;
  title: string;
  progress: ProgressStep[];
  /** Linha curta e humana (sem termos técnicos). */
  headline: string;
  estimate: { label: string; brl: number; lines: { label: string; value: string }[] } | null;
  approval: {
    kind: "presenter" | "product";
    title: string;
    imageUrl: string | null;
    referenceId: string;
    checklist: string[];
    /** Especificações exatas conferidas uma a uma (vão ao servidor como `confirmedSpecs`). */
    specs: string[];
    /** Foto REAL do avatar salvo (null = sem foto/sintético). */
    avatarPhotoUrl: string | null;
    avatarName: string | null;
    canGenerateOther: boolean;
    simulated: boolean;
  } | null;
  error: { message: string; details: string; retry: "job" | "scene" | "planning" | "planning_approval"; sceneId?: string; sceneToken?: string } | null;
  result: { videoUrl: string; downloadUrl: string; durationLabel: string; costLabel: string } | null;
  /** `label` é o que a tela afirma; só diz "Apresentado por X" quando a foto de X é usada de fato. */
  avatar: { name: string | null; label: string; reason: string } | null;
  voice: { label: string; reason: string } | null;
  jobId: string | null;
  quoteToken: string | null;
}

export const PROGRESS_LABELS: Record<ProgressStep["id"], string> = {
  script: "Preparando roteiro",
  presenter: "Preparando apresentadora",
  video: "Criando vídeo",
  finish: "Finalizando",
};

/** "00:36" */
export function clockLabel(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** Checklist simples da conferência do produto (os itens técnicos ficam nos detalhes). */
export const PRODUCT_CHECKLIST = ["Cor e formato corretos", "Logo/textos corretos", "Especificações corretas"] as const;

function steps(states: [ProgressState, ProgressState, ProgressState, ProgressState]): ProgressStep[] {
  return (["script", "presenter", "video", "finish"] as const).map((id, i) => ({ id, label: PROGRESS_LABELS[id], state: states[i]! }));
}

/** Item do checklist para uma especificação exata conhecida (ex.: 2100W). */
export function specChecklistItem(spec: string): string {
  return `“${spec}” igual ao produto (ou não aparece) — nenhum número diferente`;
}

/**
 * Cabeçalho "Apresentado por …": só afirma o nome quando a foto do avatar é de fato usada.
 * Avatar sem foto = descrição (pode variar); bloqueado/sintético = sem o nome do avatar.
 */
function avatarHeader(view: CampaignView, creative: CreativeView | undefined): ProjectV2View["avatar"] {
  const selection = view.avatarSelection;
  if (!selection) return null;
  const identity = creative?.ugc?.identity;
  if (!identity) return { name: null, label: selection.name ? `Avatar escolhido: ${selection.name}` : "Apresentadora gerada automaticamente", reason: selection.reason };
  if (identity.strategy === "avatar_reference_image") return { name: identity.avatarName, label: `Apresentado por ${identity.avatarName ?? selection.name ?? "seu avatar"}`, reason: selection.reason };
  if (identity.strategy === "avatar_description") return { name: null, label: `Inspirado em ${identity.avatarName ?? selection.name ?? "seu avatar"} (avatar sem foto: aparência pela descrição)`, reason: selection.reason };
  return { name: null, label: "Apresentadora gerada automaticamente", reason: selection.reason };
}

/** Título do erro + causa real sanitizada (nunca só a mensagem genérica). */
export function planningFailureDetails(error: CampaignView["error"]): string {
  if (!error) return "Sem detalhes.";
  const cause = planningErrorDetails(error.detail);
  return cause ? `${error.title}. Causa: ${cause}` : `${error.title}: ${error.message}`;
}

function failedScene(creative: CreativeView) {
  return creative.scenes.find((s) => s.status === "failed");
}

export function buildProjectV2View(view: CampaignView): ProjectV2View {
  const creative = view.creatives[0];
  const base = {
    title: view.projectName || view.product.name,
    avatar: avatarHeader(view, creative),
    voice: creative?.voiceLock ? { label: creative.voiceLock.strategyLabel, reason: creative.voiceLock.reason } : null,
    jobId: creative?.jobId ?? null,
    quoteToken: creative?.jobQuote?.token ?? null,
    estimate: null, approval: null, error: null, result: null,
  } satisfies Partial<ProjectV2View>;

  // Planejamento REAL aguardando aprovação (campanha em rascunho, nenhuma execução ainda).
  if (view.planningQuote?.ready && view.planning.runs === 0 && view.creatives.length === 0) {
    const q = view.planningQuote;
    return {
      ...base, phase: "planning_approval", headline: "Tudo pronto para começar.", quoteToken: q.token,
      estimate: { label: `Estimativa do roteiro: ${formatBrl(q.estimatedBrl)}`, brl: q.estimatedBrl, lines: [{ label: "Roteiro (Claude)", value: formatBrl(q.estimatedBrl) }] },
      progress: steps(["current", "pending", "pending", "pending"]),
    };
  }
  if (view.state === "planning") return { ...base, phase: "planning", headline: "Escrevendo o roteiro do seu vídeo.", progress: steps(["current", "pending", "pending", "pending"]) };
  if (view.state === "failed" || view.state === "interrupted") {
    const q = view.planningQuote?.mode === "real" ? view.planningQuote : undefined;
    return {
      ...base, phase: "planning_failed", headline: "Não conseguimos preparar o roteiro.",
      quoteToken: q?.ready ? q.token : null,
      estimate: q ? { label: `Nova tentativa do roteiro: ${formatBrl(q.estimatedBrl)}`, brl: q.estimatedBrl, lines: [{ label: "Roteiro (Claude)", value: formatBrl(q.estimatedBrl) }] } : null,
      // Erro simples na tela; "Ver detalhes" mostra a causa real sanitizada (ex.: qual trecho e por quê).
      error: { message: "Não conseguimos preparar o roteiro.", details: [planningFailureDetails(view.error), q?.blocked].filter(Boolean).join(" · "), retry: q ? "planning_approval" : "planning" },
      progress: steps(["error", "pending", "pending", "pending"]),
    };
  }
  if (!creative) return { ...base, phase: "planning", headline: "Preparando o projeto.", progress: steps(["current", "pending", "pending", "pending"]) };

  const ugc = creative.ugc;
  const presenterReady = !!ugc?.approved && ugc.fidelity?.status === "approved";
  const ugcScenes = creative.scenes.filter((s) => s.visualSource.startsWith("ugc_"));
  const videoReady = ugcScenes.length > 0 && ugcScenes.every((s) => s.status === "ready");
  const scriptStep: ProgressState = "done";
  const presenterStep: ProgressState = presenterReady ? "done" : ugc?.awaitingApproval || ugc?.canConfirmFidelity || creative.activity ? "current" : "pending";
  const failed = failedScene(creative);

  if (creative.latestRender) {
    return {
      ...base, phase: "done", headline: "Seu vídeo está pronto",
      result: {
        videoUrl: creative.latestRender.videoUrl, downloadUrl: creative.latestRender.downloadUrl,
        durationLabel: clockLabel(creative.latestRender.durationSeconds ?? creative.durationSeconds),
        costLabel: formatBrl(creative.actual?.totalBrl ?? 0),
      },
      progress: steps(["done", "done", "done", "done"]),
    };
  }
  if (creative.result?.simulated) {
    return { ...base, phase: "simulated_done", headline: "Simulação concluída — nenhum vídeo real foi criado.", progress: steps(["done", "done", "done", "done"]) };
  }
  const reference = ugc?.current;
  if (ugc && reference && (ugc.canApprove || ugc.canConfirmFidelity)) {
    // Correção Lote 6: avatar salvo COM foto → a foto real do avatar aparece ao lado da referência e
    // a pessoa também é conferida ("é a Cristina?"). Sem foto ou sintético → revisão da apresentadora.
    // Nunca uma pessoa diferente com o nome do avatar sem essa conferência.
    const withPhoto = ugc.identity.strategy === "avatar_reference_image";
    const name = ugc.identity.avatarName;
    const title = withPhoto ? `Confira ${name ?? "o avatar"} com o produto` : name ? `${name} (sem foto): confira a apresentadora` : "Esta será sua apresentadora";
    const checklist = [
      ...(withPhoto ? [`É ${name ?? "o avatar"}: mesmo rosto da foto do avatar`] : []),
      ...PRODUCT_CHECKLIST,
      ...ugc.specs.map(specChecklistItem),
    ];
    return {
      ...base, phase: withPhoto ? "product_check" : "presenter_review",
      headline: title,
      approval: {
        kind: withPhoto ? "product" : "presenter", title,
        imageUrl: reference.previewUrl, referenceId: reference.id, checklist,
        specs: [...ugc.specs], avatarPhotoUrl: ugc.identity.avatarPhotoUrl, avatarName: name,
        canGenerateOther: ugc.canRegenerate, simulated: reference.isMock,
      },
      progress: steps([scriptStep, "current", "pending", "pending"]),
    };
  }
  if (creative.activity) {
    const rendering = creative.activity.phase === "rendering";
    return {
      ...base, phase: "generating", headline: rendering ? "Finalizando seu vídeo." : "Gerando seu vídeo.",
      progress: steps([scriptStep, presenterReady ? "done" : "current", rendering || videoReady ? "done" : presenterReady ? "current" : "pending", rendering ? "current" : "pending"]),
    };
  }
  if (failed || creative.interrupted || (creative.authorization?.status === "paused" && creative.error)) {
    const number = failed?.number;
    const message = number ? `Não conseguimos gerar o trecho ${number}.` : creative.interrupted ? "A geração foi interrompida." : "Não conseguimos continuar a geração.";
    const sceneToken = failed?.regenerationQuote?.ready ? failed.regenerationQuote.token : undefined;
    return {
      ...base, phase: "failed", headline: message,
      error: { message, details: [creative.error, creative.authorization?.pausedReason, failed ? `Cena ${failed.number}` : undefined].filter(Boolean).join(" · ") || "Sem detalhes.", retry: sceneToken ? "scene" : "job", ...(failed ? { sceneId: failed.id } : {}), ...(sceneToken ? { sceneToken } : {}) },
      progress: steps([scriptStep, presenterReady ? "done" : "error", presenterReady ? "error" : "pending", "pending"]),
    };
  }
  const quote = creative.jobQuote;
  if (!creative.authorization || creative.authorization.status === "paused") {
    return {
      ...base, phase: "ready_to_generate", headline: quote?.blocked ? quote.blocked : "Roteiro pronto. Gere o vídeo quando quiser.",
      estimate: quote ? {
        label: `Estimativa: ${formatBrl(quote.estimatedBrl)}`, brl: quote.estimatedBrl,
        lines: [
          ...quote.stages.filter((s) => s.estimatedBrl > 0 && !s.done).map((s) => ({ label: STAGE_NAMES[s.stage] ?? s.stage, value: formatBrl(s.estimatedBrl) })),
          { label: "Teto autorizado", value: formatBrl(quote.maximumAuthorizedBrl) },
        ],
      } : null,
      progress: steps([scriptStep, presenterStep === "current" ? "current" : presenterReady ? "done" : "pending", "pending", "pending"]),
    };
  }
  return { ...base, phase: "generating", headline: "Gerando seu vídeo.", progress: steps([scriptStep, presenterReady ? "done" : "current", videoReady ? "done" : presenterReady ? "current" : "pending", "pending"]) };
}

const STAGE_NAMES: Record<string, string> = {
  ugc_reference: "Apresentadora", ugc_video: "Vídeo", narration: "Voz", scenes: "Cenas", render: "Finalização", avatar: "Avatar", planning: "Roteiro",
};

// ---------------------------------------------------------------- Projetos (cards)

/**
 * L8.6 — status HONESTO do projeto (cards de Projetos e da Home). Sem "Rascunho": um projeto já
 * criado espera aprovação, está na fila, gerando, pronto, falhou, pausado por segurança ou precisa
 * de você. Worker offline NÃO muda o status (o job continua na fila).
 */
export type ProjectStatus = "awaiting_approval" | "queued" | "preparing" | "generating" | "attention" | "ready" | "failed" | "blocked" | "simulated";
export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  awaiting_approval: "Aguardando aprovação", queued: "Na fila", preparing: "Preparando roteiro", generating: "Gerando",
  attention: "Precisa de atenção", ready: "Pronto", failed: "Falhou", blocked: "Pausado por segurança", simulated: "Simulação",
};

export interface ProjectCard {
  id: string;
  name: string;
  productName: string;
  /** Prioridade: referência visual real > foto do produto > null (placeholder). */
  thumbnailUrl: string | null;
  thumbnailKind: "reference" | "product" | null;
  avatarName: string | null;
  durationLabel: string | null;
  status: ProjectStatus;
  statusLabel: string;
  createdAt: string;
  dateLabel: string;
  /** Custo REAL do ledger (BRL, sem simulados); null = nada real registrado. */
  actualBrl: number | null;
  /** Estimativa aprovada (BRL) enquanto está em produção; exibir sempre com "~". */
  estimatedBrl: number | null;
}

export interface ProjectFlags {
  planningActive: boolean;
  jobActive: boolean;
  /** L8.6: execução ativa ainda na fila (nenhum worker assumiu). */
  planningQueued?: boolean;
  jobQueued?: boolean;
}

/** L8.8.1: a regra mora em `statusFromFacts` (a mesma usada pelo shell e pela consulta leve do cloud). */
export function projectStatus(campaign: Campaign, job: GenerationJob | undefined, flags: ProjectFlags): ProjectStatus {
  return statusFromFacts(projectFactsOf(campaign, job), { planningActive: flags.planningActive, planningQueued: flags.planningQueued === true, jobActive: flags.jobActive, jobQueued: flags.jobQueued === true });
}

function thumbnail(campaign: Campaign, job: GenerationJob | undefined): Pick<ProjectCard, "thumbnailUrl" | "thumbnailKind"> {
  const reference = job?.ugc?.references.findLast((r) => r.state === "succeeded" && !r.isMock && r.review !== "rejected");
  if (job && reference) return { thumbnailUrl: ugcReferenceUrl(campaign.id, job.creativeId, reference.version), thumbnailKind: "reference" };
  const image = campaign.request.product.images[0];
  const url = image ? imagePreviewUrl(campaign.request.product.id, image.id) ?? null : null;
  return { thumbnailUrl: url, thumbnailKind: url ? "product" : null };
}

export function projectCard(campaign: Campaign, job: GenerationJob | undefined, flags: ProjectFlags, actualBrl: number | null = null): ProjectCard {
  const status = projectStatus(campaign, job, flags);
  const rendered = job?.renders.findLast((r) => r.status === "completed")?.durationSeconds;
  const planned = campaign.plan?.creatives[0]?.duration;
  const seconds = rendered ?? campaign.request.targetDurationSeconds ?? planned;
  const auth = job?.jobAuthorization;
  const inProduction = status === "queued" || status === "generating";
  return {
    id: campaign.id,
    name: campaign.request.projectName || campaign.request.product.name,
    productName: campaign.request.product.name,
    ...thumbnail(campaign, job),
    avatarName: campaign.request.avatar?.snapshot?.name ?? (campaign.request.creativeMode === "ai_ugc" ? "Automático" : null),
    durationLabel: seconds ? `${Math.round(seconds)}s` : null,
    status, statusLabel: PROJECT_STATUS_LABELS[status],
    createdAt: campaign.createdAt,
    dateLabel: new Date(campaign.createdAt).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" }),
    actualBrl: actualBrl && actualBrl > 0 ? actualBrl : null,
    estimatedBrl: inProduction && auth ? auth.estimatedBrl + auth.baselineActualBrl : null,
  };
}

/** Filtros com estados reais. "in_progress" (Lote 6) continua aceito pela API como "em produção". */
export type ProjectFilter = "all" | "in_production" | "awaiting_approval" | "ready" | "attention" | "in_progress";
export const PROJECT_FILTERS: readonly { id: Exclude<ProjectFilter, "in_progress">; label: string }[] = [
  { id: "all", label: "Todos" }, { id: "in_production", label: "Em produção" }, { id: "awaiting_approval", label: "Aguardando aprovação" },
  { id: "ready", label: "Prontos" }, { id: "attention", label: "Precisam de atenção" },
];

export function matchesFilter(card: ProjectCard, filter: ProjectFilter): boolean {
  switch (filter) {
    case "all": return true;
    case "ready": return card.status === "ready" || card.status === "simulated";
    case "awaiting_approval": return card.status === "awaiting_approval";
    case "attention": return card.status === "attention" || card.status === "failed" || card.status === "blocked";
    case "in_production": case "in_progress": return card.status === "preparing" || card.status === "queued" || card.status === "generating";
  }
}

export type ProjectSort = "recent" | "oldest" | "cost";
export const PROJECT_SORTS: readonly { id: ProjectSort; label: string }[] = [
  { id: "recent", label: "Mais recentes" }, { id: "oldest", label: "Mais antigos" }, { id: "cost", label: "Maior consumo" },
];

const strip = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Busca (nome, produto, avatar) + filtro + ordenação, no cliente. "Maior consumo" = custo real. */
export function queryProjects(cards: readonly ProjectCard[], q: { search?: string; filter?: ProjectFilter; sort?: ProjectSort }): ProjectCard[] {
  const term = strip(q.search?.trim() ?? "");
  const list = cards.filter((c) => matchesFilter(c, q.filter ?? "all") && (!term || [c.name, c.productName, c.avatarName ?? ""].some((v) => strip(v).includes(term))));
  const sort = q.sort ?? "recent";
  return list.sort((a, b) =>
    sort === "oldest" ? a.createdAt.localeCompare(b.createdAt)
    : sort === "cost" ? (b.actualBrl ?? 0) - (a.actualBrl ?? 0) || b.createdAt.localeCompare(a.createdAt)
    : b.createdAt.localeCompare(a.createdAt));
}

export async function listProjectCards(deps: Pick<AppDeps, "service">, limit = 100): Promise<ProjectCard[]> {
  const { service } = deps;
  // Custo real por projeto: UMA leitura do ledger (sem simulados), agrupada por campanha.
  const actual = new Map<string, number>();
  for (const entry of await service.listCostEntries()) if (!entry.simulated) actual.set(entry.campaignId, (actual.get(entry.campaignId) ?? 0) + entry.costBrl);
  const cards: ProjectCard[] = [];
  for (const id of await service.listCampaignIds()) {
    try {
      const campaign = await service.getCampaign(id);
      const jobs = await service.listJobs(id);
      const job = jobs[0];
      cards.push(projectCard(campaign, job, {
        planningActive: service.isPlanningActive(id),
        planningQueued: service.executionState({ campaignId: id }) === "queued",
        jobActive: job ? service.isJobActive(job.id) : false,
        jobQueued: job ? service.executionState({ jobId: job.id }) === "queued" : false,
      }, actual.has(id) ? Math.round(actual.get(id)! * 100) / 100 : null));
    } catch {
      // Projeto ilegível: continua acessível em Configurações → Diagnóstico.
    }
  }
  return cards.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}
