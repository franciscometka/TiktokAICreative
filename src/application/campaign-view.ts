import { presenterSceneViews, type PresenterSceneView } from "./presenter-view";
import { claudeModelName } from "@/config/llm-models";
import type { ActualCostSummary } from "@/costs/ledger";
import type { ProductAnalysis } from "@/domain/campaign";
import type { CostBudget } from "@/domain/cost";
import type { CreativePlan, VisualSource } from "@/domain/creative";
import type { Campaign, GenerationJob, JobStatus, StyleSelection } from "@/domain/pipeline";
import type { RenderRecord } from "@/domain/render";
import { mediaComplete } from "@/pipeline/guards";
import type { CreativeReview } from "@/domain/plan-evaluation";
import type { Range } from "@/domain/quality";
import { STORED_IMAGE_NAME } from "@/domain/upload";
import { roundBrl } from "@/lib/money";
import {
  presentActualCosts,
  presentBudgetDecision,
  presentEstimate,
  type ActualCostPresentation,
  type BudgetDecisionPresentation,
  type EstimatePresentation,
} from "./cost-presentation";
import {
  CAMPAIGN_STATUS_NAMES,
  JOB_STATUS_NAMES,
  MOTION_NAMES,
  SHOT_TYPE_NAMES,
  STYLE_NAMES,
  TRANSITION_NAMES,
  VISUAL_SOURCE_NAMES,
} from "./labels";
import { buildNarrationView, type AudioProviderId, type NarrationView } from "./narration-view";
import { planningUserError, type UserError } from "./user-errors";

/**
 * View model SERIALIZÁVEL da campanha para a interface (Server → Client Components).
 * Contém só o que a tela mostra: sem configuração privada, sem caminhos de disco além das URIs
 * relativas das imagens, sem API key.
 */

export type CampaignState = "planning" | "interrupted" | "failed" | "planned";

export interface ImageView {
  id: string;
  previewUrl: string;
}

export interface SceneView {
  id: string;
  number: number;
  startSeconds: number;
  endSeconds: number;
  visualSource: VisualSource;
  visualSourceLabel: string;
  isGenerated: boolean;
  generatedSeconds: number;
  motionLabel: string | undefined;
  shotTypeLabel: string;
  transitionLabel: string | undefined;
  narration: string;
  onScreenText: string;
  visualDescription: string;
  generationPrompt: string;
}

export interface PresetAdjustmentView {
  qualityLabel: string;
  /** Quem sugeriu o plano original ("Claude" ou "Planejamento simulado"). */
  suggestedBy: string;
  suggestedSeconds: number;
  adjustedSeconds: number;
  messages: string[];
}

export interface RenderView {
  renderId: string;
  videoUrl: string;
  downloadUrl: string;
  sizeBytes: number | null;
  durationSeconds: number | null;
  totalFrames: number | null;
  renderMs: number | null;
  finishedAt: string | null;
  warnings: string[];
}

/** URL do vídeo por IDs (nunca caminho). O route handler resolve e valida no servidor. */
export function renderVideoUrl(campaignId: string, creativeId: string, renderId: string, download = false): string {
  const base = `/api/renders/${encodeURIComponent(campaignId)}/${encodeURIComponent(creativeId)}/${encodeURIComponent(renderId)}`;
  return download ? `${base}?download=1` : base;
}

function renderView(record: RenderRecord, campaignId: string, creativeId: string): RenderView | undefined {
  if (record.status !== "completed" || !record.renderId || !record.outputUri || record.isMock) return undefined;
  return {
    renderId: record.renderId,
    videoUrl: renderVideoUrl(campaignId, creativeId, record.renderId),
    downloadUrl: renderVideoUrl(campaignId, creativeId, record.renderId, true),
    sizeBytes: record.sizeBytes ?? null,
    durationSeconds: record.durationSeconds ?? null,
    totalFrames: record.totalFrames ?? null,
    renderMs: record.renderMs ?? null,
    finishedAt: record.finishedAt ?? null,
    warnings: record.warnings.map((w) => w.message),
  };
}

export interface JobActivity {
  active: boolean;
  progress?: { renderedFrames: number; totalFrames: number };
}

export interface CreativeView {
  presenters?: PresenterSceneView[];
  number: number;
  id: string;
  jobId: string | undefined;
  jobStatus: JobStatus | undefined;
  jobStatusLabel: string;
  concept: { title: string; angle: string; formatLabel: string; emotion: string; hook: string; description: string };
  hook: string;
  script: string;
  callToAction: string;
  durationSeconds: number;
  generatedSeconds: number;
  scenes: SceneView[];
  adjustment: PresetAdjustmentView | undefined;
  warnings: string[];
  estimate: EstimatePresentation | undefined;
  /** Decisão de orçamento pendente e de onde ela veio (define a ação "Autorizar"). */
  budgetDecision: { source: "approval" | "generation"; decision: BudgetDecisionPresentation } | undefined;
  actual: ActualCostPresentation | undefined;
  result: { outputUri: string; simulated: boolean; durationSeconds: number; assetCount: number } | undefined;
  /** Geração/render acontecendo agora neste processo. Progresso só quando o renderer informa frames reais. */
  activity:
    | { phase: "generating" | "rendering"; renderedFrames: number | null; totalFrames: number | null }
    | undefined;
  /** Job em generating/rendering sem execução no processo (servidor caiu/reiniciou). */
  interrupted: boolean;
  /** Último render real concluído (MP4 em disco), para player e download. */
  latestRender: RenderView | undefined;
  /** Versões anteriores concluídas (mais nova primeiro, sem a última). */
  previousRenders: RenderView[];
  /** Último render que falhou depois do último sucesso (para mostrar o erro). */
  lastRenderError: string | undefined;
  canRerender: boolean;
  /** Narração (Lote 4): voz, provider, custo estimado × real, status, encaixe, player. */
  narration: NarrationView;
  error: string | undefined;
  canApprove: boolean;
  canCancel: boolean;
}

export interface CampaignView {
  id: string;
  createdAt: string;
  updatedAt: string;
  state: CampaignState;
  statusLabel: string;
  product: {
    id: string;
    name: string;
    description: string;
    url: string | undefined;
    priceBrl: number | undefined;
    audience: string | undefined;
    images: ImageView[];
  };
  strategy: {
    qualityLabel: string;
    llmModelName: string;
    llmEffort: string;
    creativeCount: number;
    styleSelection: StyleSelection;
    styleLabels: string[];
    generatedVideoSeconds: Range;
    finalVideoSeconds: Range;
  };
  budget: CostBudget;
  planning: { startedAt: string | undefined; runs: number; simulated: boolean };
  error: (UserError & { detail: string | undefined }) | undefined;
  analysis: ProductAnalysis | undefined;
  hooks: { id: string; text: string; angle: string; styleLabel: string }[];
  creatives: CreativeView[];
  costs: {
    /** Real (ledger), toda a campanha. */
    actual: ActualCostPresentation;
    /** Soma do custo FUTURO estimado dos criativos ainda não gerados. */
    pendingFutureBrl: number;
    /** Já utilizado + futuro pendente. */
    projectedBrl: number;
    containsPlaceholderPrices: boolean;
  };
}

export function imagePreviewUrl(productId: string, imageId: string): string | undefined {
  if (!STORED_IMAGE_NAME.test(imageId)) return undefined;
  return `/api/uploads/${encodeURIComponent(productId)}/${encodeURIComponent(imageId)}`;
}

export function campaignState(campaign: Campaign, planningActive: boolean): CampaignState {
  switch (campaign.status) {
    case "draft":
    case "planning":
      return planningActive ? "planning" : "interrupted";
    case "planned":
      return "planned";
    case "failed":
      return "failed";
  }
}

const APPROVABLE: readonly JobStatus[] = ["cost_estimated", "awaiting_approval"];
const CANCELLABLE: readonly JobStatus[] = ["planned", "cost_estimated", "awaiting_approval", "budget_exceeded", "audio_review"];
/** Jobs cujo custo futuro ainda pode acontecer (entram no "projetado" da campanha). */
const PENDING_FUTURE: readonly JobStatus[] = ["planned", "cost_estimated", "awaiting_approval", "budget_exceeded"];

function sceneViews(creative: CreativePlan): SceneView[] {
  let cursor = 0;
  return creative.scenes.map((scene) => {
    const start = cursor;
    cursor += scene.duration;
    return {
      id: scene.id,
      number: scene.order + 1,
      startSeconds: start,
      endSeconds: cursor,
      visualSource: scene.visualSource,
      visualSourceLabel: VISUAL_SOURCE_NAMES[scene.visualSource],
      isGenerated: scene.requiresGeneratedVideo,
      generatedSeconds: scene.estimatedGenerationSeconds,
      motionLabel: scene.motion === "none" ? undefined : MOTION_NAMES[scene.motion],
      shotTypeLabel: SHOT_TYPE_NAMES[scene.shotType],
      transitionLabel: scene.transition ? TRANSITION_NAMES[scene.transition] : undefined,
      narration: scene.narration,
      onScreenText: scene.onScreenText,
      visualDescription: scene.visualDescription,
      generationPrompt: scene.generationPrompt,
    };
  });
}

/** Ajuste de fitPlanToPreset mostrado como otimização, não como erro. */
export function presetAdjustment(
  review: CreativeReview | undefined,
  qualityLabel: string,
  plannerId: string | undefined,
): PresetAdjustmentView | undefined {
  if (!review || review.adjustments.length === 0) return undefined;
  return {
    qualityLabel,
    suggestedBy: plannerId === "mock" ? "Planejamento simulado" : "Claude",
    suggestedSeconds: review.original.generatedSeconds,
    adjustedSeconds: review.final.generatedSeconds,
    messages: review.adjustments.map((a) => a.message),
  };
}

function creativeView(
  creative: CreativePlan,
  index: number,
  campaign: Campaign,
  job: GenerationJob | undefined,
  jobActual: ActualCostSummary | undefined,
  activity: JobActivity | undefined,
  audioProvider: AudioProviderId,
): CreativeView {
  const review = campaign.reviews?.find((r) => r.creativeId === creative.id);
  const status = job?.status;
  const running = status === "generating" || status === "rendering";
  const active = running && activity?.active === true;
  const interrupted = running && !active;
  const renders = (job?.renders ?? [])
    .map((r) => (job ? renderView(r, campaign.id, job.creativeId) : undefined))
    .filter((r): r is RenderView => r !== undefined)
    .reverse();
  const lastCompletedIndex = (job?.renders ?? []).findLastIndex((r) => r.status === "completed");
  const failedAfter = (job?.renders ?? []).slice(lastCompletedIndex + 1).findLast((r) => r.status === "failed");
  const pending = job?.pendingBudgetDecision;
  const completed = status === "completed" && job?.outputUri !== undefined && job.manifest !== undefined;
  return {
    number: index + 1,
    id: creative.id,
    jobId: job?.id,
    jobStatus: status,
    jobStatusLabel: interrupted ? "Interrompido" : status ? JOB_STATUS_NAMES[status] : "Sem job",
    concept: {
      title: creative.concept.title,
      angle: creative.concept.angle,
      formatLabel: STYLE_NAMES[creative.concept.format],
      emotion: creative.concept.targetEmotion,
      hook: creative.concept.hook,
      description: creative.concept.description,
    },
    hook: creative.hook,
    script: creative.script,
    callToAction: creative.callToAction,
    durationSeconds: creative.duration,
    generatedSeconds: review?.final.generatedSeconds ?? job?.estimate?.generatedVideoSeconds ?? 0,
    scenes: sceneViews(creative),
    presenters: presenterSceneViews(campaign, creative, job),
    adjustment: presetAdjustment(review, campaign.settings.label, campaign.plannerId),
    warnings: review?.final.warnings.map((w) => w.message) ?? [],
    estimate: job?.estimate ? presentEstimate(job.estimate) : undefined,
    budgetDecision:
      pending && (status === "awaiting_approval" || status === "budget_exceeded")
        ? {
            source: status === "budget_exceeded" ? "generation" : "approval",
            decision: presentBudgetDecision(pending),
          }
        : undefined,
    actual: jobActual && jobActual.entryCount > 0 ? presentActualCosts(jobActual) : undefined,
    result:
      completed && job.outputUri && job.manifest
        ? {
            outputUri: job.outputUri,
            simulated: job.outputUri.startsWith("mock://") || (jobActual?.includesSimulated ?? false),
            durationSeconds: job.manifest.duration,
            assetCount: job.manifest.assets.length,
          }
        : undefined,
    error: job?.error,
    activity: active
      ? {
          phase: status === "rendering" ? "rendering" : "generating",
          renderedFrames: activity?.progress?.renderedFrames ?? null,
          totalFrames: activity?.progress?.totalFrames ?? null,
        }
      : undefined,
    interrupted,
    latestRender: renders[0],
    previousRenders: renders.slice(1),
    lastRenderError: failedAfter?.error,
    // Re-render só com toda a mídia pronta (completed/failed) ou para retomar uma interrupção.
    canRerender:
      job !== undefined &&
      job.approval !== undefined &&
      (interrupted || ((status === "completed" || status === "failed") && mediaComplete(job))),
    narration: buildNarrationView({ campaign, job, jobActual, active, configuredProvider: audioProvider }),
    canApprove: status !== undefined && APPROVABLE.includes(status) && job?.estimate !== undefined,
    canCancel: status !== undefined && CANCELLABLE.includes(status),
  };
}

export interface BuildCampaignViewInput {
  campaign: Campaign;
  jobs: readonly GenerationJob[];
  planningActive: boolean;
  campaignActual: ActualCostSummary;
  jobActuals: ReadonlyMap<string, ActualCostSummary>;
  /** Execução de cada job neste processo (para "interrompido" e progresso). */
  jobActivity?: ReadonlyMap<string, JobActivity>;
  /** Provider de narração configurado (antes da primeira geração). */
  audioProvider?: AudioProviderId;
}

export function buildCampaignView({
  campaign,
  jobs,
  planningActive,
  campaignActual,
  jobActuals,
  jobActivity = new Map(),
  audioProvider = "mock",
}: BuildCampaignViewInput): CampaignView {
  const state = campaignState(campaign, planningActive);
  const request = campaign.request;
  const product = request.product;
  const plan = campaign.plan;
  const jobByCreative = new Map(jobs.map((j) => [j.creativeId, j]));

  const creatives = (plan?.creatives ?? []).map((creative, i) => {
    const job = jobByCreative.get(creative.id);
    return creativeView(
      creative,
      i,
      campaign,
      job,
      job ? jobActuals.get(job.id) : undefined,
      job ? jobActivity.get(job.id) : undefined,
      audioProvider,
    );
  });

  const pendingJobs = jobs.filter((j) => PENDING_FUTURE.includes(j.status) && j.estimate);
  const pendingFutureBrl = roundBrl(pendingJobs.reduce((acc, j) => acc + (j.estimate?.estimatedAdditionalBrl ?? 0), 0));
  const actual = presentActualCosts(campaignActual);

  let error: CampaignView["error"];
  if (state === "interrupted") error = { ...planningUserError("interrupted"), detail: undefined };
  else if (state === "failed") {
    error = { ...planningUserError(campaign.errorCode ?? "unknown"), detail: campaign.error };
  }

  return {
    id: campaign.id,
    createdAt: campaign.createdAt,
    updatedAt: campaign.updatedAt,
    state,
    statusLabel: CAMPAIGN_STATUS_NAMES[state],
    product: {
      id: product.id,
      name: product.name,
      description: product.description,
      url: product.url,
      priceBrl: product.priceBrl,
      audience: product.targetAudience,
      images: product.images.flatMap((image) => {
        const previewUrl = imagePreviewUrl(product.id, image.id);
        return previewUrl ? [{ id: image.id, previewUrl }] : [];
      }),
    },
    strategy: {
      qualityLabel: campaign.settings.label,
      llmModelName: claudeModelName(campaign.settings.llm.model),
      llmEffort: campaign.settings.llm.effort,
      creativeCount: request.creativeCount,
      styleSelection: request.styleSelection ?? "manual",
      styleLabels: request.styles.map((s) => STYLE_NAMES[s]),
      generatedVideoSeconds: campaign.settings.generatedVideoSeconds,
      finalVideoSeconds: campaign.settings.finalVideoSeconds,
    },
    budget: request.budget,
    planning: {
      startedAt: campaign.planningStartedAt,
      runs: campaign.planningRuns ?? 1,
      simulated: campaign.plannerId === "mock",
    },
    error,
    analysis: plan?.analysis,
    hooks: (plan?.hooks ?? []).map((h) => ({ id: h.id, text: h.text, angle: h.angle, styleLabel: STYLE_NAMES[h.style] })),
    creatives,
    costs: {
      actual,
      pendingFutureBrl,
      projectedBrl: roundBrl(actual.totalBrl + pendingFutureBrl),
      containsPlaceholderPrices: pendingJobs.some((j) => j.estimate?.containsPlaceholderPrices),
    },
  };
}

export interface CampaignListItem {
  id: string;
  productName: string;
  createdAt: string;
  qualityLabel: string;
  creativeCount: number;
  state: CampaignState;
  statusLabel: string;
  actualCostBrl: number;
  simulated: boolean;
}

export function campaignListItem(
  campaign: Campaign,
  planningActive: boolean,
  actual: ActualCostSummary,
): CampaignListItem {
  const state = campaignState(campaign, planningActive);
  return {
    id: campaign.id,
    productName: campaign.request.product.name,
    createdAt: campaign.createdAt,
    qualityLabel: campaign.settings.label,
    creativeCount: campaign.request.creativeCount,
    state,
    statusLabel: CAMPAIGN_STATUS_NAMES[state],
    actualCostBrl: roundBrl(actual.totalBrl),
    simulated: actual.includesSimulated,
  };
}
