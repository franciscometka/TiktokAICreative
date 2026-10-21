import type { Campaign, GenerationJob } from "@/domain/pipeline";
import { formatBrl } from "@/lib/money";
import type { AppDeps } from "./campaign-actions";
import { campaignState, imagePreviewUrl, type CampaignView, type CreativeView } from "./campaign-view";
import { planningErrorDetails } from "./user-errors";

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
  error: { message: string; details: string; retry: "job" | "scene" | "planning"; sceneId?: string; sceneToken?: string } | null;
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
    return {
      ...base, phase: "planning_failed", headline: "Não conseguimos preparar o roteiro.",
      // Erro simples na tela; "Ver detalhes" mostra a causa real sanitizada (ex.: qual trecho e por quê).
      error: { message: "Não conseguimos preparar o roteiro.", details: planningFailureDetails(view.error), retry: "planning" },
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

export type ProjectStatus = "draft" | "preparing" | "waiting" | "generating" | "ready" | "attention" | "simulated";
export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  draft: "Rascunho", preparing: "Preparando", waiting: "Aguardando você", generating: "Gerando", ready: "Pronto", attention: "Precisa de atenção", simulated: "Simulação",
};

export interface ProjectCard {
  id: string;
  name: string;
  thumbnailUrl: string | null;
  avatarName: string | null;
  durationLabel: string | null;
  status: ProjectStatus;
  statusLabel: string;
  createdAt: string;
  dateLabel: string;
}

export function projectStatus(campaign: Campaign, job: GenerationJob | undefined, planningActive: boolean, jobActive: boolean): ProjectStatus {
  const state = campaignState(campaign, planningActive);
  if (state === "planning") return "preparing";
  if (state === "failed" || state === "interrupted") return campaign.status === "draft" && !planningActive ? "draft" : "attention";
  if (!job) return "draft";
  if (jobActive) return "generating";
  const done = job.renders.findLast((r) => r.status === "completed");
  if (job.status === "completed" && done) return done.isMock ? "simulated" : "ready";
  if (job.status === "failed" || job.scenes.some((s) => s.attempts.at(-1)?.status === "failed")) return "attention";
  if (job.waitingForStage || job.jobAuthorization?.status === "paused") return "waiting";
  if (job.status === "generating" || job.status === "rendering") return "attention"; // interrompido
  return "draft";
}

export function projectCard(campaign: Campaign, job: GenerationJob | undefined, flags: { planningActive: boolean; jobActive: boolean }): ProjectCard {
  const image = campaign.request.product.images[0];
  const status = projectStatus(campaign, job, flags.planningActive, flags.jobActive);
  const rendered = job?.renders.findLast((r) => r.status === "completed")?.durationSeconds;
  const planned = campaign.plan?.creatives[0]?.duration;
  const seconds = rendered ?? campaign.request.targetDurationSeconds ?? planned;
  return {
    id: campaign.id,
    name: campaign.request.projectName || campaign.request.product.name,
    thumbnailUrl: image ? imagePreviewUrl(campaign.request.product.id, image.id) ?? null : null,
    avatarName: campaign.request.avatar?.snapshot?.name ?? (campaign.request.creativeMode === "ai_ugc" ? "Automático" : null),
    durationLabel: seconds ? `${Math.round(seconds)}s` : null,
    status, statusLabel: PROJECT_STATUS_LABELS[status],
    createdAt: campaign.createdAt,
    dateLabel: new Date(campaign.createdAt).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" }),
  };
}

export type ProjectFilter = "all" | "ready" | "in_progress" | "attention";
export function matchesFilter(card: ProjectCard, filter: ProjectFilter): boolean {
  if (filter === "all") return true;
  if (filter === "ready") return card.status === "ready";
  if (filter === "attention") return card.status === "attention" || card.status === "waiting";
  return card.status === "preparing" || card.status === "generating" || card.status === "draft";
}

export async function listProjectCards(deps: Pick<AppDeps, "service">, limit = 100): Promise<ProjectCard[]> {
  const { service } = deps;
  const cards: ProjectCard[] = [];
  for (const id of await service.listCampaignIds()) {
    try {
      const campaign = await service.getCampaign(id);
      const jobs = await service.listJobs(id);
      cards.push(projectCard(campaign, jobs[0], { planningActive: service.isPlanningActive(id), jobActive: jobs[0] ? service.isJobActive(jobs[0].id) : false }));
    } catch {
      // Projeto ilegível: continua acessível em Configurações → Diagnóstico.
    }
  }
  return cards.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}
