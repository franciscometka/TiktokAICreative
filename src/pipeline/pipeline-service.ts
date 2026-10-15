import { generatePresenter, presenterPreview, PresenterPendingError, type PresenterFlowDeps } from "./presenter-flow";
import type { PresenterProvider } from "@/providers/presenter/presenter-provider";
import { readFile } from "node:fs/promises";
import type { AvatarPreset } from "@/domain/presenter";
import { costForUsage } from "@/costs/calculate";
import { presenterBilledSeconds } from "@/config/presenters";
import { RUNWAY_PRESENTER } from "@/config/presenters";
import { alignedPresenterPlan, slicePresenterAudio, type AudioSlicer } from "@/speech/presenter-audio";
import { scenePromptFor } from "@/ai/video-prompt";
import type { GeneratedVisualSource } from "@/domain/creative";
import {
  PlanningError,
  PlanningUnavailableError,
  type CreativePlanner,
  type PlanningRequest,
  type PlanningResult,
  type PlanningWorstCase,
} from "@/ai/planner";
import type { LlmCallAttempt } from "@/ai/structured-output";
import { authorizeOverBudget, checkBudget, type BudgetCheckResult } from "@/costs/budget";
import {
  buildActualCost,
  estimateCreativeCost,
  llmCallCostLines,
  resolveLlmPricing,
  resolvePricing,
  worstCaseLlmCostUsd,
  type LlmPricing,
  type ResolvedPricing,
  type Usage,
} from "@/costs/calculate";
import type { ExchangeRateProvider } from "@/costs/exchange-rate";
import { summarizeActualCosts, type ActualCostSummary, type CostLedger } from "@/costs/ledger";
import type { PricingCatalog } from "@/costs/pricing-catalog";
import { reviewCampaignPlan } from "@/costs/plan-evaluation";
import { resolveQualitySettings } from "@/costs/quality";
import type {
  BudgetExceededDecision,
  CostCategory,
  CostEstimate,
  CostOperation,
  GenerationCost,
  IncurredCost,
  ProviderPricing,
} from "@/domain/cost";
import type { NarrationInfo, NarrationTiming } from "@/domain/audio";
import type { CreativePlan, ScenePlan } from "@/domain/creative";
import { getSpeakerProfile } from "@/config/voices";
import {
  CampaignRequestSchema,
  type Campaign,
  type CampaignErrorCode,
  type CampaignRequest,
  type GenerationJob,
  type MediaAttempt,
  type MediaKind,
} from "@/domain/pipeline";
import type { Clock } from "@/lib/clock";
import type { QualitySettings } from "@/domain/quality";
import type { IdGenerator } from "@/lib/ids";
import { KeyedMutex } from "@/lib/keyed-mutex";
import { roundBrl, roundUsd, toCents, usdToBrl } from "@/lib/money";
import type { AudioProviderFactory } from "@/providers/audio";
import type { AudioProvider, AudioResult } from "@/providers/audio/audio-provider";
import { waitForCompletion, type PollOptions } from "@/providers/poll";
import { InvalidMediaError, ProviderError, type MediaResult, type ProviderJobRef } from "@/providers/types";
import { checkClipDuration, clipRejectionMessage, type ClipDurationCheck } from "@/domain/media-integrity";
import type { VideoProviderFactory } from "@/providers/video";
import type { VideoProvider } from "@/providers/video/video-provider";
import { buildRenderManifest } from "@/render/manifest";
import type { RenderProgress, Renderer, RenderResult } from "@/render/renderer";
import type { RenderManifest, RenderRecord } from "@/domain/render";
import type { LlmCallLog } from "@/storage/llm-call-log";
import type { PipelineStore } from "@/storage/pipeline-store";
import type { AudioAssetStore } from "@/storage/audio-asset-store";
import { AlignmentMismatchError, narrationTiming } from "@/speech/alignment";
import { evaluateAudioFit } from "@/speech/audio-fit";
import { buildNarrationScript, type NarrationScript } from "@/speech/narration-script";
import { budgetSnapshot, narrationEstimateBrl, remainingEstimateBrl, sceneEstimateBrl } from "./budget-context";
import {
  activeAttempt,
  assertApprovalValid,
  mediaComplete,
  assertAttemptsAvailable,
  assertCanStartPaidCall,
  assertStatus,
  discardedAttemptIds,
  StaleEstimateError,
  UnexpectedStatusError,
} from "./guards";
import type { VideoAssetStore } from "@/storage/video-asset-store";
import type { PricingRef } from "@/domain/quality";
import { transitionCampaign, transitionJob } from "./states";

export interface PipelineDeps {
  planner: CreativePlanner;
  offlineOnly?: boolean;
  stageDelayMs?: number;
  presenterProviderFactory?: (pricing: ProviderPricing) => PresenterProvider;
  presenterAudioSlicer?: AudioSlicer;
  videoChoice?: PricingRef;
  videoAssets?: VideoAssetStore;
  videoProviderFactory: VideoProviderFactory;
  audioProviderFactory: AudioProviderFactory;
  renderer: Renderer;
  /** Narrações versionadas (arquivo + timing + metadata), independentes do renderer. */
  audioAssets: AudioAssetStore;
  store: PipelineStore;
  ledger: CostLedger;
  llmCallLog: LlmCallLog;
  pricing: PricingCatalog;
  exchangeRates: ExchangeRateProvider;
  maxAttemptsPerScene: number;
  pollOptions: PollOptions;
  outputDir: string;
  clock: Clock;
  ids: IdGenerator;
}

export class PlanningBudgetError extends Error {
  override name = "PlanningBudgetError";
}

export class PlanningInProgressError extends Error {
  override name = "PlanningInProgressError";
}

export class JobInProgressError extends Error {
  override name = "JobInProgressError";
}

export type BudgetExceededOutcome = { kind: "BUDGET_EXCEEDED"; decision: BudgetExceededDecision; job: GenerationJob };
export type ApproveOutcome = { kind: "APPROVED"; job: GenerationJob } | BudgetExceededOutcome;
export type GenerationOutcome =
  | { kind: "COMPLETED"; job: GenerationJob }
  /** Narração real bem mais longa que o planejado: espera decisão explícita (nada é regerado sozinho). */
  | { kind: "AUDIO_REVIEW"; job: GenerationJob }
  | { kind: "FAILED"; job: GenerationJob; error: string }
  | BudgetExceededOutcome;
export type RegenerationOutcome =
  | { kind: "REGENERATED"; job: GenerationJob }
  | { kind: "AUDIO_REVIEW"; job: GenerationJob }
  | { kind: "FAILED"; job: GenerationJob; error: string }
  | BudgetExceededOutcome;

export interface ApprovalRequest {
  job: GenerationJob;
  estimate: CostEstimate;
  /** Resultado da checagem de orçamento — a UI mostra antes do botão "Gerar por ~R$X". */
  budgetCheck: BudgetCheckResult;
}

export interface JobCostReport {
  estimate: CostEstimate | undefined;
  /** Custo efetivo do job (geração + render), incluindo tentativas descartadas. */
  actual: ActualCostSummary;
}

interface JobContext {
  job: GenerationJob;
  campaign: Campaign;
  creative: CreativePlan;
  pricing: ResolvedPricing;
}

/**
 * Orquestrador central. Não conhece UI nem fornecedores específicos.
 *
 * Fluxo: planCampaign → estimateCost → requestApproval → approve → generate
 *        → (budget_exceeded → resolveBudgetDecision) → rendering → completed
 *        → regenerateScene (opcional, com checagem de orçamento)
 */
export class PipelineService {
  private readonly campaignLocks = new KeyedMutex();
  /**
   * Planejamentos em execução NESTE processo. Não é fila durável: se o processo cair, a campanha
   * fica em "planning" sem entrada aqui e passa a ser vista como interrompida.
   */
  private readonly activePlanning = new Map<string, Promise<Campaign>>();
  /** Gerações/renders em execução NESTE processo (mesma regra: não é fila durável). */
  private readonly activeJobs = new Map<string, Promise<GenerationOutcome>>();
  private readonly renderProgress = new Map<string, RenderProgress>();

  constructor(private readonly deps: PipelineDeps) {}

  // ---------------------------------------------------------------- planejamento

  /**
   * Produto → plano validado → revisão contra o preset → jobs com estimativa de custo.
   * Espera o planejamento terminar. A UI usa startPlanning (não bloqueia).
   */
  async planCampaign(input: CampaignRequest): Promise<Campaign> {
    const { completion } = await this.startPlanning(input);
    return completion;
  }

  /**
   * Valida o pedido, checa o pior caso contra o orçamento, persiste a campanha em "planning"
   * e dispara o planejamento NESTE processo, sem esperar. `completion` termina quando a campanha
   * vira "planned" ou "failed" (nunca rejeita por falha do planner; só por falha de I/O).
   *
   * O custo REAL de cada chamada ao LLM (inclusive tentativas inválidas e falhas) vai para o ledger.
   * Nenhuma chamada paga de MÍDIA acontece aqui.
   */
  async startPlanning(input: CampaignRequest): Promise<{ campaign: Campaign; completion: Promise<Campaign> }> {
    const { store, clock, ids } = this.deps;
    this.assertPlannerAvailable();
    const request = CampaignRequestSchema.parse(input);
    const resolved = resolveQualitySettings(request.quality, request.customSettings);
    const settings = this.deps.videoChoice && request.quality !== "custom" ? { ...resolved, video: this.deps.videoChoice } : resolved;
    await this.assertPlanningFitsBudget(request, settings, 0);

    const createdAt = clock();
    let campaign: Campaign = {
      id: ids("campaign"),
      status: "draft",
      executionMode: this.deps.offlineOnly ? "offline" : undefined,
      request,
      settings,
      plannerId: this.deps.planner.id,
      jobIds: [],
      createdAt,
      updatedAt: createdAt,
    };
    await store.saveCampaign(campaign);
    campaign = this.beginPlanningRun(campaign);
    await store.saveCampaign(campaign);
    return { campaign, completion: this.launchPlanning(campaign) };
  }

  /**
   * Planeja de novo uma campanha que falhou ou foi interrompida. Ação EXPLÍCITA do usuário:
   * é uma nova chamada paga. O pior caso + o que o planejamento já custou precisa caber no orçamento.
   */
  async retryPlanning(campaignId: string): Promise<{ campaign: Campaign; completion: Promise<Campaign> }> {
    this.assertPlannerAvailable();
    return this.campaignLocks.run(campaignId, async () => {
      let campaign = await this.deps.store.getCampaign(campaignId);
      this.assertExecutionMode(campaign);
      if (this.isPlanningActive(campaignId)) {
        throw new PlanningInProgressError("O planejamento desta campanha ainda está em andamento");
      }
      if (campaign.status === "planning") campaign = this.markInterrupted(campaign);
      // "draft" = o processo caiu entre criar a campanha e iniciar o planejamento.
      if (campaign.status !== "failed" && campaign.status !== "draft") {
        throw new UnexpectedStatusError(`Campanha em "${campaign.status}" não pode ser planejada de novo`);
      }
      const spent = (await this.planningEntries(campaign.id)).reduce((acc, e) => acc + e.costBrl, 0);
      await this.assertPlanningFitsBudget(campaign.request, campaign.settings, spent);

      campaign = this.beginPlanningRun({ ...campaign, error: undefined, errorCode: undefined });
      await this.deps.store.saveCampaign(campaign);
      return { campaign, completion: this.launchPlanning(campaign) };
    });
  }

  /** false = o planner configurado não pode ser usado (ex.: sem ANTHROPIC_API_KEY). */
  planningAvailable(): boolean {
    return this.deps.planner.unavailable === undefined;
  }

  /** true se ESTE processo está executando o planejamento da campanha. */
  isPlanningActive(campaignId: string): boolean {
    return this.activePlanning.has(campaignId);
  }

  /**
   * Campanha em "planning" sem execução neste processo = interrompida (o processo caiu/reiniciou).
   * Derivado, sem escrita: a retomada é sempre uma ação explícita (retryPlanning).
   */
  isPlanningInterrupted(campaign: Campaign): boolean {
    return campaign.status === "planning" && !this.isPlanningActive(campaign.id);
  }

  getCampaign(campaignId: string): Promise<Campaign> {
    return this.deps.store.getCampaign(campaignId);
  }

  getJob(jobId: string): Promise<GenerationJob> {
    return this.deps.store.getJob(jobId);
  }

  listJobs(campaignId: string): Promise<GenerationJob[]> {
    return this.deps.store.listJobs(campaignId);
  }

  listCampaignIds(): Promise<string[]> {
    return this.deps.store.listCampaignIds();
  }

  private assertPlannerAvailable(): void {
    const unavailable = this.deps.planner.unavailable;
    if (unavailable) throw new PlanningUnavailableError(unavailable.kind, unavailable.message);
  }

  /** Pior caso desta execução + o que o planejamento já custou precisa caber no orçamento da campanha. */
  private async assertPlanningFitsBudget(
    request: CampaignRequest,
    settings: QualitySettings,
    alreadySpentBrl: number,
  ): Promise<void> {
    const pricing = resolvePricing(settings, this.deps.pricing);
    const rate = (await this.deps.exchangeRates.getUsdBrl()).rate;
    const worstCaseBrl = usdToBrl(
      worstCaseLlmCostUsd(pricing.llm, this.toWorstCaseParams(this.toPlanningRequest(request, settings))),
      rate,
    );
    if (toCents(alreadySpentBrl + worstCaseBrl) > toCents(request.budget.maxCostPerCampaignBrl)) {
      throw new PlanningBudgetError(
        `O pior caso do planejamento (R$${worstCaseBrl.toFixed(2)}) excede o orçamento da campanha`,
      );
    }
  }

  private beginPlanningRun(campaign: Campaign): Campaign {
    const now = this.deps.clock();
    return {
      ...transitionCampaign(campaign, "planning", now),
      planningRunId: this.deps.ids("planrun"),
      planningStartedAt: now,
      planningRuns: (campaign.planningRuns ?? 0) + 1,
    };
  }

  private markInterrupted(campaign: Campaign): Campaign {
    return {
      ...transitionCampaign(campaign, "failed", this.deps.clock()),
      errorCode: "interrupted",
      error: "O planejamento foi interrompido antes de terminar (o servidor parou ou reiniciou).",
    };
  }

  private launchPlanning(campaign: Campaign): Promise<Campaign> {
    const run = this.runPlanning(campaign).finally(() => {
      if (this.activePlanning.get(campaign.id) === run) this.activePlanning.delete(campaign.id);
    });
    this.activePlanning.set(campaign.id, run);
    return run;
  }

  private async runPlanning(started: Campaign): Promise<Campaign> {
    const { store, clock } = this.deps;
    const settings = started.settings;
    const pricing = resolvePricing(settings, this.deps.pricing);
    const rate = (await this.deps.exchangeRates.getUsdBrl()).rate;

    let outcome: { ok: true; result: PlanningResult } | { ok: false; error: unknown };
    try {
      outcome = { ok: true, result: await this.deps.planner.plan(this.toPlanningRequest(started.request, settings)) };
    } catch (error) {
      outcome = { ok: false, error };
    }

    return this.campaignLocks.run(started.id, async () => {
      // Custo real SEMPRE registrado, mesmo que esta execução tenha sido substituída.
      if (outcome.ok) await this.recordLlmCalls(started.id, outcome.result.calls, settings, rate, outcome.result);
      else if (outcome.error instanceof PlanningError) {
        await this.recordLlmCalls(started.id, outcome.error.calls, settings, rate, outcome.error.meta);
      }

      let campaign = await store.getCampaign(started.id);
      if (campaign.status !== "planning" || campaign.planningRunId !== started.planningRunId) {
        console.warn(`Planejamento ${started.planningRunId} da campanha ${started.id} foi substituído; resultado descartado`);
        return campaign;
      }

      if (!outcome.ok) {
        console.error(`Planejamento da campanha ${started.id} falhou:`, messageOf(outcome.error));
        campaign = {
          ...transitionCampaign(campaign, "failed", clock()),
          error: messageOf(outcome.error),
          errorCode: planningErrorCode(outcome.error),
        };
        await store.saveCampaign(campaign);
        return campaign;
      }

      const selectedPlan = started.request.presenterPresetId ? {
        ...outcome.result.plan, creatives: outcome.result.plan.creatives.map(creative => {
          const first = creative.scenes.find(s => s.requiresGeneratedVideo && s.narration.trim());
          return { ...creative, scenes: creative.scenes.map(s => s.id === first?.id ? { ...s, visualSource: "presenter" as const, motion: "none" as const } : s) };
        }),
      } : outcome.result.plan;
      const review = reviewCampaignPlan(selectedPlan, settings, pricing, rate);
      const jobs = review.plan.creatives.map((creative) => this.newJob(campaign.id, creative));
      for (const job of jobs) await store.saveJob(job);
      campaign = {
        ...transitionCampaign(campaign, "planned", clock()),
        plan: review.plan,
        reviews: review.reviews,
        jobIds: jobs.map((j) => j.id),
      };
      await store.saveCampaign(campaign);

      // Estimar é cálculo puro (gratuito): todos os jobs já saem com custo incorrido × futuro.
      for (const job of jobs) await this.estimateJob(job.id);
      return campaign;
    });
  }

  private toPlanningRequest(request: CampaignRequest, settings: QualitySettings): PlanningRequest {
    return {
      product: request.product,
      presenterPresetId: request.presenterPresetId,
      projectName: request.projectName, videoConcept: request.videoConcept, scriptMode: request.scriptMode, script: request.script,
      styles: request.styles,
      creativeCount: request.creativeCount,
      settings,
    };
  }

  // ---------------------------------------------------------------- estimativa e aprovação

  /** Calcula (ou recalcula) a estimativa. Qualquer aprovação anterior deixa de valer. */
  async estimateCost(jobId: string): Promise<GenerationJob> {
    return this.withJobLock(jobId, () => this.estimateJob(jobId));
  }

  /** Sem lock: quem chama já segura o lock da campanha. */
  private async estimateJob(jobId: string): Promise<GenerationJob> {
    const { job, campaign, creative, pricing } = await this.load(jobId);
    const rate = (await this.deps.exchangeRates.getUsdBrl()).rate;
    const estimate = estimateCreativeCost({
      reusedNarration: Boolean(activeAttempt(job.audioAttempts)?.narration?.reusedFromJobId),
      id: this.deps.ids("estimate"),
      plan: creative,
      settings: campaign.settings,
      pricing,
      incurred: await this.incurredPlanningShare(campaign),
      exchangeRate: rate,
      createdAt: this.deps.clock(),
    });
    const next: GenerationJob = {
      ...transitionJob(job, "cost_estimated", this.deps.clock()),
      estimate,
      approval: undefined,
      pendingBudgetDecision: undefined,
    };
    await this.deps.store.saveJob(next);
    return next;
  }

  async requestApproval(jobId: string): Promise<ApprovalRequest> {
    return this.withJobLock(jobId, async () => {
      const ctx = await this.load(jobId);
      assertStatus(ctx.job, "cost_estimated");
      const estimate = ctx.job.estimate;
      if (!estimate) throw new UnexpectedStatusError("Job sem estimativa");
      const job = transitionJob(ctx.job, "awaiting_approval", this.deps.clock());
      await this.deps.store.saveJob(job);
      const budgetCheck = await this.checkJobBudget({ ...ctx, job }, remainingEstimateBrl(job));
      return { job, estimate, budgetCheck };
    });
  }

  /**
   * Aprovação humana explícita de UMA estimativa específica.
   * Se o orçamento for excedido, retorna BUDGET_EXCEEDED e só aprova se
   * `authorizeOverBudget` for true E a política permitir.
   */
  async approve(
    jobId: string,
    options: { estimateId: string; authorizeOverBudget?: boolean },
  ): Promise<ApproveOutcome> {
    return this.withJobLock(jobId, async () => {
      const ctx = await this.load(jobId);
      let job = ctx.job;
      assertStatus(job, "awaiting_approval");
      const estimate = job.estimate;
      if (!estimate || estimate.id !== options.estimateId) {
        throw new StaleEstimateError("A estimativa aprovada não é a estimativa atual do job");
      }

      const additional = remainingEstimateBrl(job);
      let check = await this.checkJobBudget({ ...ctx, job }, additional);
      if (check.kind === "BUDGET_EXCEEDED") {
        if (!options.authorizeOverBudget) return this.returnDecision(job, check);
        job = {
          ...job,
          overBudgetAuthorization: authorizeOverBudget(
            check,
            ctx.campaign.request.budget,
            this.deps.clock(),
            job.overBudgetAuthorization,
          ),
        };
        check = await this.checkJobBudget({ ...ctx, job }, additional);
        // Outro escopo (ex.: campanha) também excedido: exige nova decisão explícita.
        if (check.kind === "BUDGET_EXCEEDED") return this.returnDecision(job, check);
      }

      job = {
        ...job,
        approval: {
          estimateId: estimate.id,
          approvedTotalBrl: estimate.projectedTotalBrl,
          approvedAt: this.deps.clock(),
          overBudget: check.usesOverBudgetAuthorization,
        },
        pendingBudgetDecision: undefined,
        updatedAt: this.deps.clock(),
      };
      await this.deps.store.saveJob(job);
      return { kind: "APPROVED", job };
    });
  }

  // ---------------------------------------------------------------- geração

  /**
   * Inicia geração de mídia + render EM BACKGROUND neste processo e retorna logo após persistir
   * "generating". Exige aprovação válida para a estimativa atual. `completion` termina com o
   * desfecho (COMPLETED, FAILED ou BUDGET_EXCEEDED).
   */
  async startGeneration(jobId: string): Promise<{ job: GenerationJob; completion: Promise<GenerationOutcome> }> {
    const job = await this.withJobLock(jobId, async () => {
      this.assertJobIdle(jobId);
      const ctx = await this.load(jobId);
      assertStatus(ctx.job, "awaiting_approval");
      assertApprovalValid(ctx.job);
      const next = transitionJob(ctx.job, "generating", this.deps.clock());
      await this.deps.store.saveJob(next);
      return next;
    });
    return { job, completion: this.launchJob(jobId, () => this.continueGeneration(jobId)) };
  }

  /** Como startGeneration, mas espera o desfecho (scripts e testes). */
  async generate(jobId: string): Promise<GenerationOutcome> {
    const { completion } = await this.startGeneration(jobId);
    return completion;
  }

  /** Resolve uma pausa por orçamento: cancelar ou autorizar explicitamente o excedente (e seguir em background). */
  async startBudgetResolution(
    jobId: string,
    choice: "cancel" | "authorize",
  ): Promise<{ job: GenerationJob; completion: Promise<GenerationOutcome> }> {
    const job = await this.withJobLock(jobId, async () => {
      this.assertJobIdle(jobId);
      const ctx = await this.load(jobId);
      assertStatus(ctx.job, "budget_exceeded");
      const pending = ctx.job.pendingBudgetDecision;
      if (!pending) throw new UnexpectedStatusError("Job em budget_exceeded sem decisão pendente");
      const next: GenerationJob =
        choice === "cancel"
          ? { ...transitionJob(ctx.job, "cancelled", this.deps.clock()), pendingBudgetDecision: undefined }
          : {
              ...transitionJob(ctx.job, "generating", this.deps.clock()),
              overBudgetAuthorization: authorizeOverBudget(
                pending,
                ctx.campaign.request.budget,
                this.deps.clock(),
                ctx.job.overBudgetAuthorization,
              ),
              pendingBudgetDecision: undefined,
            };
      await this.deps.store.saveJob(next);
      return next;
    });
    if (choice === "cancel") {
      const cancelled: GenerationOutcome = { kind: "FAILED", job, error: "Cancelado pelo usuário por orçamento" };
      return { job, completion: Promise.resolve(cancelled) };
    }
    return { job, completion: this.launchJob(jobId, () => this.continueGeneration(jobId)) };
  }

  async resolveBudgetDecision(jobId: string, choice: "cancel" | "authorize"): Promise<GenerationOutcome> {
    const { completion } = await this.startBudgetResolution(jobId, choice);
    return completion;
  }

  /**
   * Ação EXPLÍCITA do usuário: renderiza de novo (nova versão, nada é sobrescrito) ou retoma um
   * job interrompido (processo caiu em "generating"/"rendering"). Nunca acontece sozinho.
   * Render local não tem custo de API; geração retomada só refaz cenas sem asset ativo e checa o
   * orçamento antes de cada chamada.
   */
  async startRerender(jobId: string): Promise<{ job: GenerationJob; completion: Promise<GenerationOutcome> }> {
    let resumeGeneration = false;
    const job = await this.withJobLock(jobId, async () => {
      this.assertJobIdle(jobId);
      const ctx = await this.load(jobId);
      let next = ctx.job;
      assertApprovalValid(next);
      if (next.status === "generating") {
        resumeGeneration = true; // interrompido durante a geração: continua de onde parou
        return next;
      }
      if (next.status === "rendering") {
        next = { ...this.markInterruptedRender(next), error: "Renderização interrompida (o servidor parou)." };
        next = transitionJob(next, "failed", this.deps.clock());
      }
      assertStatus(next, "completed", "failed");
      if (!mediaComplete(next)) {
        throw new UnexpectedStatusError("A geração deste criativo não terminou; não há o que renderizar");
      }
      next = { ...transitionJob(next, "rendering", this.deps.clock()), error: undefined };
      await this.deps.store.saveJob(next);
      return next;
    });
    const run = resumeGeneration ? () => this.continueGeneration(jobId) : () => this.renderPhase(jobId);
    return { job, completion: this.launchJob(jobId, run) };
  }

  /**
   * Narração em revisão (fala real bem mais longa que o planejado): o usuário ACEITA o vídeo mais
   * longo. Nenhuma chamada paga; o fim do vídeo é estendido para a fala caber inteira.
   */
  async acceptNarration(jobId: string): Promise<{ job: GenerationJob; completion: Promise<GenerationOutcome> }> {
    const job = await this.withJobLock(jobId, async () => {
      this.assertJobIdle(jobId);
      const ctx = await this.load(jobId);
      assertStatus(ctx.job, "audio_review");
      const active = activeAttempt(ctx.job.audioAttempts);
      if (!active?.narration) throw new UnexpectedStatusError("Não há narração ativa para aceitar");
      const acceptedAt = this.deps.clock();
      const next: GenerationJob = {
        ...transitionJob(ctx.job, ctx.creative.scenes.some(s => s.visualSource === "presenter") ? "generating" : "rendering", acceptedAt),
        audioAttempts: ctx.job.audioAttempts.map((a) =>
          a.id === active.id && a.narration ? { ...a, narration: { ...a.narration, reviewAcceptedAt: acceptedAt } } : a,
        ),
        error: undefined,
      };
      await this.deps.store.saveJob(next);
      return next;
    });
    return { job, completion: this.launchJob(jobId, () => job.status === "generating" ? this.continueGeneration(jobId) : this.renderPhase(jobId)) };
  }

  /**
   * Ação EXPLÍCITA: gera a narração de novo (nova versão, NOVO custo, tentativa anterior vira
   * descartada mas continua no total). Respeita o limite de tentativas e o orçamento; com
   * orçamento excedido devolve a decisão sem chamar nada. Se a nova chamada falhar, a narração
   * anterior continua valendo. Roda em background.
   */
  async startNarrationRegeneration(
    jobId: string,
    options: { authorizeOverBudget?: boolean } = {},
  ): Promise<{ kind: "started"; job: GenerationJob; completion: Promise<GenerationOutcome> } | BudgetExceededOutcome> {
    const prepared = await this.withJobLock(jobId, async () => {
      this.assertJobIdle(jobId);
      const ctx = await this.load(jobId);
      let job = ctx.job;
      assertStatus(job, "completed", "audio_review");
      assertApprovalValid(job);
      assertAttemptsAvailable(job.audioAttempts, this.deps.maxAttemptsPerScene);
      if (job.scenes.some(s => activeAttempt(s.attempts)?.presenter)) throw new UnexpectedStatusError("Este criativo já tem presenter sincronizado. Crie uma nova campanha para trocar a narração sem reutilizar lip sync antigo.");
      const previousStatus = job.status as "completed" | "audio_review";

      const additional = narrationEstimateBrl(job);
      let check = await this.checkJobBudget({ ...ctx, job }, additional);
      if (check.kind === "BUDGET_EXCEEDED") {
        if (!options.authorizeOverBudget) return { kind: "BUDGET_EXCEEDED" as const, decision: check, job };
        job = {
          ...job,
          overBudgetAuthorization: authorizeOverBudget(check, ctx.campaign.request.budget, this.deps.clock(), job.overBudgetAuthorization),
        };
        check = await this.checkJobBudget({ ...ctx, job }, additional);
        if (check.kind === "BUDGET_EXCEEDED") return this.returnDecisionWithoutStateChange(job, check);
      }
      job = { ...transitionJob(job, "generating", this.deps.clock()), error: undefined };
      await this.deps.store.saveJob(job);
      return { kind: "started" as const, job, previousStatus };
    });
    if (prepared.kind === "BUDGET_EXCEEDED") return prepared;
    const completion = this.launchJob(jobId, () => this.regenerateNarrationNow(jobId, prepared.previousStatus));
    return { kind: "started", job: prepared.job, completion };
  }

  private async regenerateNarrationNow(jobId: string, previousStatus: "completed" | "audio_review"): Promise<GenerationOutcome> {
    const outcome = await this.withJobLock(jobId, async (): Promise<GenerationOutcome | { kind: "READY_TO_RENDER" }> => {
      const ctx = await this.load(jobId);
      const restore = async (job: GenerationJob, error: string): Promise<GenerationOutcome> => {
        // A narração anterior continua ativa; o criativo volta para onde estava.
        const next = { ...transitionJob(job, previousStatus, this.deps.clock()), error };
        await this.deps.store.saveJob(next);
        return { kind: "FAILED", job: next, error };
      };
      const audio = this.createAudioProvider(ctx);
      if (!audio.ok) return restore(ctx.job, audio.error);
      const result = await this.generateNarration(ctx, audio.provider);
      if (result.attempt.status === "failed") return restore(result.job, result.attempt.error ?? "Falha ao gerar a narração");
      return ctx.creative.scenes.some(s => s.visualSource === "presenter") ? this.runGeneration({ ...ctx, job: result.job }) : this.afterNarration(result.job);
    });
    if (outcome.kind !== "READY_TO_RENDER") return outcome;
    return this.renderPhase(jobId);
  }

  /** true se ESTE processo está gerando/renderizando o job. */
  isJobActive(jobId: string): boolean {
    return this.activeJobs.has(jobId);
  }

  /** Job em "generating"/"rendering" sem execução neste processo = interrompido (derivado). */
  isJobInterrupted(job: GenerationJob): boolean {
    return (job.status === "generating" || job.status === "rendering") && !this.isJobActive(job.id);
  }

  /** Progresso REAL de frames do render em andamento (só em memória). */
  getRenderProgress(jobId: string): RenderProgress | undefined {
    return this.renderProgress.get(jobId);
  }

  /**
   * Regenera o vídeo de UMA cena de um criativo concluído.
   * Custo da tentativa anterior continua contabilizado (vira "descartado").
   */
  async regenerateScene(
    jobId: string,
    sceneId: string,
    options: { authorizeOverBudget?: boolean } = {},
  ): Promise<RegenerationOutcome> {
    const generated = await this.withJobLock(jobId, async (): Promise<RegenerationOutcome | { kind: "READY_TO_RENDER" }> => {
      this.assertJobIdle(jobId);
      const ctx = await this.load(jobId);
      let job = ctx.job;
      assertStatus(job, "completed");
      const scene = ctx.creative.scenes.find((s) => s.id === sceneId);
      const state = job.scenes.find((s) => s.sceneId === sceneId);
      if (!scene || !state) throw new UnexpectedStatusError(`Cena ${sceneId} não pertence ao job`);
      if (!scene.requiresGeneratedVideo) throw new UnexpectedStatusError("Cena não usa vídeo gerado por IA");
      assertAttemptsAvailable(state.attempts, this.deps.maxAttemptsPerScene);

      let additional = sceneEstimateBrl(job, sceneId);
      if (scene.visualSource === "presenter") {
        const preview = await presenterPreview(this.deps, ctx.campaign, ctx.creative, job, scene, this.presenterProvider().descriptor.isMock);
        additional = this.presenterProvider().estimateCost(preview.durationSeconds).costUsd * (await this.deps.exchangeRates.getUsdBrl()).rate;
      }
      let check = await this.checkJobBudget({ ...ctx, job }, additional);
      if (check.kind === "BUDGET_EXCEEDED") {
        if (!options.authorizeOverBudget) return { kind: "BUDGET_EXCEEDED", decision: check, job };
        job = {
          ...job,
          overBudgetAuthorization: authorizeOverBudget(
            check,
            ctx.campaign.request.budget,
            this.deps.clock(),
            job.overBudgetAuthorization,
          ),
        };
        check = await this.checkJobBudget({ ...ctx, job }, additional);
        if (check.kind === "BUDGET_EXCEEDED") return this.returnDecisionWithoutStateChange(job, check);
      }

      let video: VideoProvider | undefined;
      try {
        if (scene.visualSource !== "presenter") {
          video = this.deps.videoProviderFactory(ctx.pricing.video);
          await video.validateRequest?.(this.videoRequest(ctx, scene));
        }
      } catch (error) { return { kind: "FAILED", job, error: messageOf(error) }; }
      job = transitionJob(job, "generating", this.deps.clock());
      await this.deps.store.saveJob(job);

      let result;
      job = await this.stage(job, scene.visualSource === "presenter" ? "avatar" : "scenes");
      try { result = scene.visualSource === "presenter"
        ? await this.generatePresenterScene({ ...ctx, job }, scene, true)
        : await this.generateSceneVideo({ ...ctx, job }, scene, video!);
      } catch (error) {
        const latest = await this.deps.store.getJob(job.id);
        if (error instanceof PresenterPendingError) return { kind: "FAILED", job: latest, error: error.message };
        return { kind: "FAILED", job: latest, error: messageOf(error) };
      }
      job = result.job;
      if (result.attempt.status === "failed") {
        // A versão anterior da cena continua válida; o vídeo final não muda.
        const error = result.attempt.error ?? "Falha na regeneração";
        job = { ...transitionJob(job, "completed", this.deps.clock()), error };
        await this.deps.store.saveJob(job);
        return { kind: "FAILED", job, error };
      }
      job = transitionJob(job, "rendering", this.deps.clock());
      await this.deps.store.saveJob(job);
      return { kind: "READY_TO_RENDER" };
    });
    if (generated.kind !== "READY_TO_RENDER") return generated;
    const rendered = await this.launchJob(jobId, () => this.renderPhase(jobId));
    return rendered.kind === "COMPLETED" ? { kind: "REGENERATED", job: rendered.job } : rendered;
  }

  async cancel(jobId: string): Promise<GenerationJob> {
    return this.withJobLock(jobId, async () => {
      const { job } = await this.load(jobId);
      const next = transitionJob(job, "cancelled", this.deps.clock());
      await this.deps.store.saveJob(next);
      return next;
    });
  }

  // ---------------------------------------------------------------- relatórios

  async getJobCostReport(jobId: string): Promise<JobCostReport> {
    const job = await this.deps.store.getJob(jobId);
    const entries = await this.deps.ledger.list({ jobId });
    return { estimate: job.estimate, actual: summarizeActualCosts(entries, discardedAttemptIds(job)) };
  }

  async getCampaignCostReport(campaignId: string): Promise<ActualCostSummary> {
    const jobs = await this.deps.store.listJobs(campaignId);
    const discarded = new Set(jobs.flatMap((j) => [...discardedAttemptIds(j)]));
    return summarizeActualCosts(await this.deps.ledger.list({ campaignId }), discarded);
  }

  // ---------------------------------------------------------------- internos

  /** Geração (sob o lock da campanha: chamadas pagas + orçamento) e depois render (fora do lock). */
  private async continueGeneration(jobId: string): Promise<GenerationOutcome> {
    const outcome = await this.withJobLock(jobId, async () => this.runGeneration(await this.load(jobId)));
    if (outcome.kind !== "READY_TO_RENDER") return outcome;
    return this.renderPhase(jobId);
  }

  private async runGeneration(ctx: JobContext): Promise<GenerationOutcome | { kind: "READY_TO_RENDER" }> {
    let job = ctx.job;
    const hasPresenter = ctx.creative.scenes.some(s => s.visualSource === "presenter");
    let video: VideoProvider | undefined;
    try {
      if (hasPresenter) {
        if (!ctx.campaign.request.presenterPresetId) throw new Error("Selecione um avatar para o presenter antes de aprovar.");
        this.presenterProvider();
      }
      const genericScenes = ctx.creative.scenes.filter(s => s.requiresGeneratedVideo && s.visualSource !== "presenter");
      if (genericScenes.length) video = this.deps.videoProviderFactory(ctx.pricing.video);
      for (const scene of genericScenes) {
        await video!.validateRequest?.(this.videoRequest(ctx, scene));
      }
    } catch (error) { return this.fail(job, messageOf(error)); }
    // Provider de áudio indisponível (ex.: sem chave) falha ANTES de qualquer chamada paga.
    const audio = this.createAudioProvider(ctx);
    if (!audio.ok) return this.fail(job, audio.error);

    if ((hasPresenter || this.deps.offlineOnly) && !activeAttempt(job.audioAttempts)) {
      const paused = await this.pauseIfOverBudget({ ...ctx, job });
      if (paused) return paused;
      job = await this.stage(job, "narration");
      const result = await this.generateNarration({ ...ctx, job }, audio.provider);
      job = result.job;
      if (result.attempt.status === "failed") return this.fail(job, result.attempt.error);
    }
    const narrationInfo = activeAttempt(job.audioAttempts)?.narration;
    if (hasPresenter && narrationInfo?.fit?.action === "review" && !narrationInfo.reviewAcceptedAt) {
      const next = transitionJob(job, "audio_review", this.deps.clock());
      await this.deps.store.saveJob(next);
      return { kind: "AUDIO_REVIEW", job: next };
    }
    for (const scene of ctx.creative.scenes) {
      if (!scene.requiresGeneratedVideo) continue;
      const state = job.scenes.find((s) => s.sceneId === scene.id);
      const pendingPresenter = job.presenterTasks?.some(t => t.sceneId === scene.id && (t.state === "pending" || t.state === "submitting"));
      if (!state || (activeAttempt(state.attempts) && !pendingPresenter)) continue;

      let additional = remainingEstimateBrl(job);
      if (scene.visualSource === "presenter" && !pendingPresenter) {
        try {
          const preview = await presenterPreview(this.deps, ctx.campaign, ctx.creative, job, scene, this.presenterProvider().descriptor.isMock);
          const rate = (await this.deps.exchangeRates.getUsdBrl()).rate;
          additional = Math.max(0, additional - sceneEstimateBrl(job, scene.id)) + this.presenterProvider().estimateCost(preview.durationSeconds).costUsd * rate;
        } catch (error) { return this.fail(job, messageOf(error)); }
      }
      const paused = pendingPresenter ? undefined : await this.pauseIfOverBudget({ ...ctx, job }, additional);
      if (paused) return paused;
      if (!pendingPresenter) assertAttemptsAvailable(state.attempts, this.deps.maxAttemptsPerScene);

      let result;
      job = await this.stage(job, scene.visualSource === "presenter" ? "avatar" : "scenes");
      try { result = scene.visualSource === "presenter"
        ? await this.generatePresenterScene({ ...ctx, job }, scene)
        : await this.generateSceneVideo({ ...ctx, job }, scene, video!);
      } catch (error) {
        const latest = await this.deps.store.getJob(job.id);
        if (error instanceof PresenterPendingError) return { kind: "FAILED", job: latest, error: error.message };
        return this.fail(latest, messageOf(error));
      }
      job = result.job;
      if (result.attempt.status === "failed") return this.fail(job, result.attempt.error);
    }

    if (!activeAttempt(job.audioAttempts)) {
      const paused = await this.pauseIfOverBudget({ ...ctx, job });
      if (paused) return paused;
      assertAttemptsAvailable(job.audioAttempts, this.deps.maxAttemptsPerScene);

      job = await this.stage(job, "narration");
      const result = await this.generateNarration({ ...ctx, job }, audio.provider);
      job = result.job;
      if (result.attempt.status === "failed") return this.fail(job, result.attempt.error);
    }

    return this.afterNarration(job);
  }

  /** Narração pronta: se a fala real passou MUITO do planejado, pede revisão; senão segue para o render. */
  private async afterNarration(job: GenerationJob): Promise<GenerationOutcome | { kind: "READY_TO_RENDER" }> {
    const info = activeAttempt(job.audioAttempts)?.narration;
    if (info?.fit?.action === "review" && !info.reviewAcceptedAt) {
      const next = transitionJob(job, "audio_review", this.deps.clock());
      await this.deps.store.saveJob(next);
      return { kind: "AUDIO_REVIEW", job: next };
    }
    const next = transitionJob(job, "rendering", this.deps.clock());
    await this.deps.store.saveJob(next);
    return { kind: "READY_TO_RENDER" };
  }

  private createAudioProvider(ctx: JobContext): { ok: true; provider: AudioProvider } | { ok: false; error: string } {
    try {
      return { ok: true, provider: this.deps.audioProviderFactory(ctx.pricing.audio) };
    } catch (error) {
      if (error instanceof ProviderError) return { ok: false, error: error.message };
      throw error;
    }
  }

  /** Checagem de orçamento antes de CADA chamada paga, com base no gasto real até aqui. */
  private async pauseIfOverBudget(ctx: JobContext, additional = remainingEstimateBrl(ctx.job)): Promise<BudgetExceededOutcome | undefined> {
    const check = await this.checkJobBudget(ctx, additional);
    if (check.kind === "WITHIN_BUDGET") return undefined;
    const job: GenerationJob = {
      ...transitionJob(ctx.job, "budget_exceeded", this.deps.clock()),
      pendingBudgetDecision: check,
    };
    await this.deps.store.saveJob(job);
    return { kind: "BUDGET_EXCEEDED", decision: check, job };
  }

  private presenterProvider(): PresenterProvider {
    if (!this.deps.presenterProviderFactory) throw new Error("Presenter Runway não configurado.");
    return this.deps.presenterProviderFactory(this.deps.pricing.requireOne(RUNWAY_PRESENTER));
  }
  private presenterDeps(): PresenterFlowDeps {
    if (!this.deps.videoAssets) throw new Error("Armazenamento de vídeo indisponível");
    return { ...this.deps, videoAssets: this.deps.videoAssets, slicer: this.deps.presenterAudioSlicer ?? slicePresenterAudio };
  }
  async previewPresenter(jobId: string, sceneId: string) {
    const ctx = await this.load(jobId);
    const scene = ctx.creative.scenes.find(s => s.id === sceneId && s.visualSource === "presenter");
    if (!scene || !ctx.campaign.request.presenterPresetId) throw new Error("Cena presenter/avatar não encontrada.");
    const preview = await presenterPreview(this.deps, ctx.campaign, ctx.creative, ctx.job, scene);
    return { ...preview, avatarPresetId: ctx.campaign.request.presenterPresetId, model: RUNWAY_PRESENTER.model,
      estimate: costForUsage(this.deps.pricing.requireOne(RUNWAY_PRESENTER), { seconds: presenterBilledSeconds(preview.durationSeconds) }) };
  }
  /** Read-only preview of reusing a real narration in a NEW one-call validation campaign. */
  async previewPresenterValidation(sourceJobId: string, avatar: AvatarPreset, sceneId?: string) {
    const ctx = await this.load(sourceJobId);
    const scene = ctx.creative.scenes.find(s => s.id === sceneId) ?? (sceneId ? undefined : ctx.creative.scenes.find(s => s.narration.trim()));
    if (!scene) throw new Error("Cena não encontrada na narração de origem.");
    const preview = await presenterPreview(this.deps, ctx.campaign, ctx.creative, ctx.job, scene);
    return { ...preview, sceneId: scene.id, avatarPresetId: avatar, model: RUNWAY_PRESENTER.model,
      estimate: costForUsage(this.deps.pricing.requireOne(RUNWAY_PRESENTER), { seconds: presenterBilledSeconds(preview.durationSeconds) }) };
  }
  /** Local copy only. Original campaign, narration, ledger and approval stay untouched. */
  async preparePresenterValidation(sourceJobId: string, avatar: AvatarPreset, sceneId?: string) {
    const preview = await this.previewPresenterValidation(sourceJobId, avatar, sceneId);
    const ctx = await this.load(sourceJobId);
    const campaignId = this.deps.ids("campaign");
    const creative = { ...ctx.creative, id: this.deps.ids("creative"), scenes: ctx.creative.scenes.map(s => ({ ...s,
      visualSource: s.id === preview.sceneId ? "presenter" as const : "product_image" as const,
      requiresGeneratedVideo: s.id === preview.sceneId, estimatedGenerationSeconds: s.id === preview.sceneId ? Math.min(s.duration, preview.durationSeconds) : 0,
      generationPrompt: s.id === preview.sceneId ? "Presenter speaking the existing narration." : "",
    })) };
    const source = activeAttempt(ctx.job.audioAttempts)!;
    const timing = await this.deps.audioAssets.readTiming(source.narration!.timingUri!);
    const stored = await this.deps.audioAssets.save({ campaignId, creativeId: creative.id, data: new Uint8Array(await readFile(preview.audioPath)), timing,
      metadata: { reusedFromJobId: sourceJobId, reusedFromAttemptId: source.id, provider: source.provider, model: source.model, noNewTtsCall: true } });
    const campaign: Campaign = { ...ctx.campaign, id: campaignId, request: { ...ctx.campaign.request, creativeCount: 1, presenterPresetId: avatar },
      plan: { ...ctx.campaign.plan!, creatives: [creative] }, reviews: [], jobIds: [], createdAt: this.deps.clock(), updatedAt: this.deps.clock() };
    const job = this.newJob(campaign.id, creative);
    job.audioAttempts = [{ ...source, id: this.deps.ids("attempt"), sceneId: null, assetUri: stored.uri,
      narration: { ...source.narration!, reusedFromJobId: sourceJobId, version: stored.version, timingUri: stored.timingUri, reviewAcceptedAt: this.deps.clock() } }];
    campaign.jobIds = [job.id];
    await this.deps.store.saveCampaign(campaign);
    await this.deps.store.saveJob(job);
    return this.estimateCost(job.id);
  }
  private async generatePresenterScene(ctx: JobContext, scene: ScenePlan, regenerate = false) {
    const provider = this.presenterProvider();
    return generatePresenter(this.presenterDeps(), { campaign: ctx.campaign, plan: ctx.creative, job: ctx.job, scene, provider,
      exchangeRate: (await this.deps.exchangeRates.getUsdBrl()).rate, regenerate });
  }
  private videoRequest(ctx: JobContext, scene: ScenePlan) {
    return { sceneId: scene.id, visualSource: scene.visualSource, prompt: scenePromptFor(scene, scene.visualSource as GeneratedVisualSource), durationSeconds: scene.estimatedGenerationSeconds,
      aspectRatio: "9:16" as const, referenceImageUris: ctx.campaign.request.product.images.map((i) => i.uri) };
  }

  private async generateSceneVideo(
    ctx: JobContext,
    scene: ScenePlan,
    provider: VideoProvider,
  ): Promise<{ job: GenerationJob; attempt: MediaAttempt }> {
    assertCanStartPaidCall(ctx.job);
    return this.executeAttempt(ctx, {
      kind: "video",
      sceneId: scene.id,
      provider: provider.descriptor,
      category: "video",
      operation: "video_generation",
      description: `Vídeo IA — cena ${scene.order + 1}`,
      run: async () => {
        const ref = await provider.generateScene(this.videoRequest(ctx, scene));
        ctx.job = { ...ctx.job, videoTasks: [...(ctx.job.videoTasks ?? []), {
          sceneId: scene.id, providerJobId: ref.providerJobId, provider: provider.descriptor.id,
          model: provider.descriptor.model, createdAt: this.deps.clock(),
        }] };
        await this.deps.store.saveJob(ctx.job);
        return this.awaitResult(ref, provider);
      },
      finalize: async (result, attemptId, ref) => {
        if (result.isMock) return { uri: result.uri, durationSeconds: result.durationSeconds };
        if (!result.data || !this.deps.videoAssets) throw new Error("Armazenamento de vídeo indisponível");
        const requested = result.requestedDurationSeconds ?? result.durationSeconds;
        const stored = await this.deps.videoAssets.save({ campaignId: ctx.campaign.id, sceneId: scene.id, data: result.data,
          metadata: { attemptId, providerJobId: ref.providerJobId, provider: provider.descriptor.id, model: provider.descriptor.model,
            requestedDurationSeconds: requested, providerReportedDurationSeconds: result.providerReportedDurationSeconds ?? null,
            billedUsage: result.billedUsage } });
        // Integridade: duração REAL do arquivo salvo × pedida (nunca confiar só no pedido/provider).
        const media = checkClipDuration({
          requestedSeconds: requested,
          providerReportedSeconds: result.providerReportedDurationSeconds,
          actualSeconds: stored.inspection.durationSeconds,
          fileComplete: stored.inspection.complete,
        });
        await this.deps.videoAssets.writeIntegrity?.(stored.uri, { ...media, checkedAt: this.deps.clock() }).catch(() => {});
        if (media.status !== "valid") {
          console.warn(`[vídeo] clipe rejeitado job=${ctx.job.id} cena=${scene.id} solicitado=${requested}s arquivo=${media.actualMediaDurationSeconds ?? "?"}s status=${media.status}`);
          throw new InvalidMediaError(clipRejectionMessage(media, scene.order + 1), media, stored.uri);
        }
        return { uri: stored.uri, durationSeconds: media.actualMediaDurationSeconds ?? requested, media };
      },
    });
  }

  private async generateNarration(
    ctx: JobContext,
    provider: AudioProvider,
  ): Promise<{ job: GenerationJob; attempt: MediaAttempt }> {
    assertCanStartPaidCall(ctx.job);
    // Narração CONTÍNUA por criativo (D55): um texto falado, uma chamada, um timing.
    const speaker = getSpeakerProfile(ctx.campaign.request.speakerProfileId);
    const script = buildNarrationScript(ctx.creative);
    return this.executeAttempt(ctx, {
      kind: "audio",
      sceneId: null,
      provider: provider.descriptor,
      category: "audio",
      operation: "audio_generation",
      description: `Narração (TTS · ${speaker.name})`,
      run: async () => {
        const ref = await provider.generateAudio({
          trackId: "narration",
          text: script.spoken,
          language: speaker.language,
          speakerProfileId: speaker.id,
        });
        return this.awaitResult(ref, provider);
      },
      finalize: (result, attemptId) =>
        this.storeNarration(ctx, { script, speakerProfileId: speaker.id, language: speaker.language }, result as AudioResult, attemptId, provider),
    });
  }

  /**
   * Depois da chamada (já registrada no ledger): converte o timing para palavras escritas,
   * mede o encaixe (AudioFit) e salva arquivo + timing + metadata numa versão NOVA.
   */
  private async storeNarration(
    ctx: JobContext,
    voice: { script: NarrationScript; speakerProfileId: string; language: NarrationInfo["language"] },
    result: AudioResult,
    attemptId: string,
    provider: AudioProvider,
  ): Promise<{ uri: string; durationSeconds: number; narration: NarrationInfo }> {
    let timing: NarrationTiming | undefined;
    let note: string | undefined;
    if (result.characterTiming) {
      try {
        timing = narrationTiming(voice.script, result.characterTiming);
      } catch (error) {
        if (!(error instanceof AlignmentMismatchError)) throw error;
        note = `${error.message}; legendas estimadas.`;
      }
    } else if (!result.isMock) {
      note = "Provider não informou timing; legendas estimadas.";
    }
    const speechSeconds = timing?.speechEndSeconds ?? result.durationSeconds;
    const fit = evaluateAudioFit({
      targetSeconds: ctx.creative.duration,
      speechSeconds,
      measured: !result.isMock && result.data !== undefined,
    });

    const narration: NarrationInfo = {
      speakerProfileId: voice.speakerProfileId,
      voiceId: result.voiceId,
      language: voice.language,
      requestId: result.requestId,
      inputCharacters: voice.script.spoken.length,
      providerCharacterCost: result.providerCharacterCost,
      captionTiming: timing ? "alignment" : "estimated",
      speechEndSeconds: timing?.speechEndSeconds,
      fit,
      note,
    };
    if (!result.data) return { uri: result.uri, durationSeconds: result.durationSeconds, narration: result.isMock && ctx.campaign.executionMode === "offline" ? { ...narration, version: `mock-v${ctx.job.audioAttempts.length + 1}` } : narration };

    const stored = await this.deps.audioAssets.save({
      campaignId: ctx.campaign.id,
      creativeId: ctx.creative.id,
      data: result.data,
      timing,
      metadata: {
        attemptId,
        jobId: ctx.job.id,
        provider: provider.descriptor.id,
        model: provider.descriptor.model,
        speakerProfileId: voice.speakerProfileId,
        voiceId: result.voiceId,
        language: voice.language,
        requestId: result.requestId,
        inputCharacters: voice.script.spoken.length,
        providerCharacterCost: result.providerCharacterCost,
        durationSeconds: result.durationSeconds,
        speechEndSeconds: timing?.speechEndSeconds,
        captionTiming: narration.captionTiming,
        fit,
        writtenText: voice.script.written,
        spokenText: voice.script.spoken,
        createdAt: this.deps.clock(),
      },
    });
    return {
      uri: stored.uri,
      durationSeconds: result.durationSeconds,
      narration: { ...narration, version: stored.version, timingUri: stored.timingUri },
    };
  }

  private async awaitResult(
    ref: ProviderJobRef,
    provider: Pick<VideoProvider, "getStatus" | "downloadResult">,
  ): Promise<{ ref: ProviderJobRef; result: MediaResult }> {
    await waitForCompletion((r) => provider.getStatus(r), ref, this.deps.pollOptions);
    return { ref, result: await provider.downloadResult(ref) };
  }

  /**
   * Executa UMA tentativa paga: registra a tentativa e o custo real (mesmo em falha faturada).
   * Em sucesso, a tentativa vira a ativa e as anteriores passam a "descartadas".
   * Nunca re-tenta automaticamente.
   */
  private async executeAttempt(
    ctx: JobContext,
    spec: {
      kind: MediaKind;
      sceneId: string | null;
      provider: { id: string; model: string; isMock: boolean; pricing: ProviderPricing };
      category: CostCategory;
      operation: CostOperation;
      description: string;
      run: () => Promise<{ ref: ProviderJobRef; result: MediaResult }>;
      /** Pós-processamento DEPOIS do custo registrado (ex.: salvar a narração). Falha = tentativa falha (custo mantido). */
      finalize?: (result: MediaResult, attemptId: string, ref: ProviderJobRef) => Promise<{ uri: string; durationSeconds: number; narration?: NarrationInfo; media?: ClipDurationCheck }>;
    },
  ): Promise<{ job: GenerationJob; attempt: MediaAttempt }> {
    const { clock, ids } = this.deps;
    const previous = spec.kind === "audio"
      ? ctx.job.audioAttempts
      : (ctx.job.scenes.find((s) => s.sceneId === spec.sceneId)?.attempts ?? []);
    const attemptId = ids("attempt");
    const base = {
      id: attemptId,
      kind: spec.kind,
      sceneId: spec.sceneId,
      attemptNumber: previous.length + 1,
      provider: spec.provider.id,
      model: spec.provider.model,
      isMock: spec.provider.isMock,
      createdAt: clock(),
    };
    const rate = (await this.deps.exchangeRates.getUsdBrl()).rate;
    const recordCost = (usage: Usage) =>
      this.deps.ledger.record(
        buildActualCost({
          id: ids("cost"),
          campaignId: ctx.campaign.id,
          jobId: ctx.job.id,
          creativeId: ctx.creative.id,
          sceneId: spec.sceneId,
          attemptId,
          operation: spec.operation,
          category: spec.category,
          description: `${spec.description} (tentativa ${base.attemptNumber})`,
          pricing: spec.provider.pricing,
          usage,
          exchangeRate: rate,
          simulated: spec.provider.isMock,
          createdAt: clock(),
        }),
      );

    let attempt: MediaAttempt;
    try {
      const { ref, result } = await spec.run();
      await recordCost(result.billedUsage);
      let output: { uri: string; durationSeconds: number; narration?: NarrationInfo; media?: ClipDurationCheck } = {
        uri: result.uri,
        durationSeconds: result.durationSeconds,
      };
      if (spec.finalize) {
        try {
          output = await spec.finalize(result, attemptId, ref);
        } catch (error) {
          // Custo já registrado acima; não registra de novo nem re-tenta.
          if (error instanceof InvalidMediaError) throw Object.assign(error, { providerJobId: ref.providerJobId });
          throw new ProviderError(`Mídia gerada (e cobrada), mas não foi possível salvar: ${messageOf(error)}`, ref.providerJobId);
        }
      }
      attempt = {
        ...base,
        providerJobId: ref.providerJobId,
        status: "succeeded",
        active: true,
        assetUri: output.uri,
        durationSeconds: output.durationSeconds,
        ...(output.narration ? { narration: output.narration } : {}),
        ...(output.media ? { media: output.media } : {}),
      };
    } catch (error) {
      if (error instanceof InvalidMediaError) {
        // Clipe inválido: tentativa falha, nunca ativa (não vai ao render); custo já está no ledger.
        attempt = {
          ...base,
          providerJobId: (error as InvalidMediaError & { providerJobId?: string }).providerJobId ?? null,
          status: "failed",
          active: false,
          error: error.message,
          media: error.media,
          ...(error.rejectedAssetUri ? { rejectedAssetUri: error.rejectedAssetUri } : {}),
        };
        return this.saveAttempt(ctx, spec, attempt);
      }
      if (!(error instanceof ProviderError)) throw error;
      if (error.billedUsage) await recordCost(error.billedUsage);
      attempt = {
        ...base,
        providerJobId: error.providerJobId ?? null,
        status: "failed",
        active: false,
        error: error.message,
        diagnostic: error.diagnostic,
      };
    }

    return this.saveAttempt(ctx, spec, attempt);
  }

  private async saveAttempt(
    ctx: JobContext,
    spec: { kind: MediaKind; sceneId: string | null },
    attempt: MediaAttempt,
  ): Promise<{ job: GenerationJob; attempt: MediaAttempt }> {
    const { clock } = this.deps;
    const withAttempt = (list: readonly MediaAttempt[]) => [
      ...list.map((a) => (attempt.status === "succeeded" ? { ...a, active: false } : a)),
      attempt,
    ];
    const job: GenerationJob =
      spec.kind === "audio"
        ? { ...ctx.job, audioAttempts: withAttempt(ctx.job.audioAttempts), updatedAt: clock() }
        : {
            ...ctx.job,
            scenes: ctx.job.scenes.map((s) =>
              s.sceneId === spec.sceneId ? { ...s, attempts: withAttempt(s.attempts) } : s,
            ),
            updatedAt: clock(),
          };
    await this.deps.store.saveJob(job);
    return { job, attempt };
  }

  /**
   * Render em três passos para não segurar o lock da campanha durante minutos:
   * 1. (lock) monta o manifest e registra o RenderRecord "rendering";
   * 2. (sem lock) renderer.render() — Remotion local, sem custo de API;
   * 3. (lock) grava o desfecho: completed + output, ou failed + erro. Custo local (R$0) no ledger.
   */
  private async renderPhase(jobId: string): Promise<GenerationOutcome> {
    const { clock, ids, renderer } = this.deps;
    const prepared = await this.withJobLock(jobId, async () => {
      const ctx = await this.load(jobId);
      let job = ctx.job;
      assertStatus(job, "rendering");
      const sceneVideos = new Map<string, string>();
      for (const s of job.scenes) {
        const active = activeAttempt(s.attempts);
        if (active?.assetUri) sceneVideos.set(s.sceneId, active.assetUri);
      }
      const narration = activeAttempt(job.audioAttempts);
      const timingUri = narration?.narration?.timingUri;
      let manifest: RenderManifest;
      try {
        const timing = timingUri ? await this.deps.audioAssets.readTiming(timingUri) : undefined;
        job = await this.stage(job, "render");
        manifest = buildRenderManifest({
          campaignId: ctx.campaign.id,
          plan: ctx.creative.scenes.some(s => s.visualSource === "presenter") && timing && narration?.durationSeconds ? alignedPresenterPlan(ctx.creative, timing, narration.durationSeconds) : ctx.creative,
          product: ctx.campaign.request.product,
          sceneVideos,
          narration: narration?.assetUri
            ? {
                uri: narration.assetUri,
                durationSeconds: narration.durationSeconds ?? 0,
                isMock: narration.isMock,
                timing,
                extendSeconds: ctx.creative.scenes.some(s => s.visualSource === "presenter") ? 0 : narration.narration?.fit?.extendSeconds ?? 0,
              }
            : undefined,
          outputDir: this.deps.outputDir,
        });
      } catch (error) {
        return { kind: "failed" as const, outcome: await this.fail(job, messageOf(error)) };
      }
      const record: RenderRecord = {
        id: ids("render"),
        status: "rendering",
        renderer: renderer.id,
        isMock: renderer.isMock,
        startedAt: clock(),
        warnings: [],
      };
      const preferredVersion = job.renders.filter((r) => r.renderId).length + 1;
      job = { ...job, manifest, renders: [...job.renders, record], updatedAt: clock() };
      await this.deps.store.saveJob(job);
      return { kind: "ready" as const, ctx, manifest, recordId: record.id, preferredVersion };
    });
    if (prepared.kind === "failed") return prepared.outcome;

    let result: RenderResult | undefined;
    let renderError: unknown;
    try {
      result = await renderer.render(prepared.manifest, {
        preferredVersion: prepared.preferredVersion,
        onProgress: (p) => this.renderProgress.set(jobId, p),
      });
    } catch (error) {
      renderError = error;
    } finally {
      this.renderProgress.delete(jobId);
    }

    return this.withJobLock(jobId, async () => {
      let job = await this.deps.store.getJob(jobId);
      const finishedAt = clock();
      const updateRecord = (patch: Partial<RenderRecord>) =>
        job.renders.map((r) => (r.id === prepared.recordId ? { ...r, ...patch, finishedAt } : r));

      if (!result) {
        const error = messageOf(renderError);
        console.error(`[render] job=${jobId} creative=${job.creativeId} falhou: ${error}`);
        job = { ...job, renders: updateRecord({ status: "failed", error }) };
        return this.fail(job, error);
      }

      const rate = (await this.deps.exchangeRates.getUsdBrl()).rate;
      await this.deps.ledger.record(
        buildActualCost({
          id: ids("cost"),
          campaignId: job.campaignId,
          jobId: job.id,
          creativeId: job.creativeId,
          sceneId: null,
          attemptId: null,
          operation: "render",
          category: "rendering",
          description: result.renderId ? `Renderização ${result.renderId} (${renderer.id})` : `Renderização (${renderer.id})`,
          pricing: prepared.ctx.pricing.rendering,
          usage: result.usage,
          exchangeRate: rate,
          simulated: result.isMock,
          createdAt: clock(),
        }),
      );
      console.warn(
        `[render] job=${jobId} campaign=${job.campaignId} creative=${job.creativeId} render=${result.renderId ?? "mock"} ` +
          `frames=${result.totalFrames ?? "-"} duracao=${result.durationSeconds ?? "-"}s tempo=${result.renderMs ?? "-"}ms ` +
          `saida=${result.outputUri} avisos=${result.warnings.length}`,
      );
      job = {
        ...transitionJob(job, "completed", clock()),
        renders: updateRecord({
          status: "completed",
          renderId: result.renderId,
          outputUri: result.outputUri,
          manifestUri: result.manifestUri,
          sizeBytes: result.sizeBytes,
          durationSeconds: result.durationSeconds,
          totalFrames: result.totalFrames,
          renderMs: result.renderMs,
          warnings: result.warnings,
        }),
        outputUri: result.outputUri,
        error: undefined,
      };
      await this.deps.store.saveJob(job);
      return { kind: "COMPLETED", job };
    });
  }

  private markInterruptedRender(job: GenerationJob): GenerationJob {
    const finishedAt = this.deps.clock();
    return {
      ...job,
      renders: job.renders.map((r) =>
        r.status === "rendering"
          ? { ...r, status: "failed", error: "Interrompido: o servidor parou durante o render", finishedAt }
          : r,
      ),
    };
  }

  private assertJobIdle(jobId: string): void {
    if (this.activeJobs.has(jobId)) throw new JobInProgressError("Este criativo já está sendo gerado ou renderizado");
  }

  private launchJob(jobId: string, fn: () => Promise<GenerationOutcome>): Promise<GenerationOutcome> {
    const run = fn().finally(() => {
      if (this.activeJobs.get(jobId) === run) this.activeJobs.delete(jobId);
    });
    this.activeJobs.set(jobId, run);
    return run;
  }

  private async fail(job: GenerationJob, error = "Falha desconhecida"): Promise<GenerationOutcome> {
    const failed = { ...transitionJob(job, "failed", this.deps.clock()), error };
    await this.deps.store.saveJob(failed);
    return { kind: "FAILED", job: failed, error };
  }

  private async returnDecision(job: GenerationJob, decision: BudgetExceededDecision): Promise<BudgetExceededOutcome> {
    const next = { ...job, pendingBudgetDecision: decision, updatedAt: this.deps.clock() };
    await this.deps.store.saveJob(next);
    return { kind: "BUDGET_EXCEEDED", decision, job: next };
  }

  private async returnDecisionWithoutStateChange(
    job: GenerationJob,
    decision: BudgetExceededDecision,
  ): Promise<BudgetExceededOutcome> {
    // Persiste só a autorização parcial já concedida; status permanece "completed".
    await this.deps.store.saveJob(job);
    return { kind: "BUDGET_EXCEEDED", decision, job };
  }

  private async checkJobBudget(ctx: JobContext, additionalBrl: number): Promise<BudgetCheckResult> {
    const [jobs, entries] = await Promise.all([
      this.deps.store.listJobs(ctx.campaign.id),
      this.deps.ledger.list({ campaignId: ctx.campaign.id }),
    ]);
    const snapshot = budgetSnapshot(ctx.job, jobs, entries);
    return checkBudget({
      budget: ctx.campaign.request.budget,
      authorization: ctx.job.overBudgetAuthorization,
      ...snapshot,
      additionalBrl,
    });
  }

  private assertExecutionMode(campaign: Campaign): void {
    if (this.deps.offlineOnly && campaign.executionMode !== "offline") throw new UnexpectedStatusError("Projeto anterior em consulta. Crie uma cópia offline para continuar sem alterar dados reais.");
  }
  private async stage(job: GenerationJob, currentStage: NonNullable<GenerationJob["currentStage"]>): Promise<GenerationJob> {
    const next = { ...job, currentStage, updatedAt: this.deps.clock() };
    await this.deps.store.saveJob(next);
    if (this.deps.stageDelayMs) await new Promise(resolve => setTimeout(resolve, this.deps.stageDelayMs));
    return next;
  }
  private async load(jobId: string): Promise<JobContext> {
    const job = await this.deps.store.getJob(jobId);
    const campaign = await this.deps.store.getCampaign(job.campaignId);
    this.assertExecutionMode(campaign);
    const creative = campaign.plan?.creatives.find((c) => c.id === job.creativeId);
    if (!creative) throw new UnexpectedStatusError(`Criativo ${job.creativeId} não encontrado no plano`);
    return { job, campaign, creative, pricing: resolvePricing(campaign.settings, this.deps.pricing) };
  }

  private newJob(campaignId: string, creative: CreativePlan): GenerationJob {
    const now = this.deps.clock();
    return {
      id: this.deps.ids("job"),
      campaignId,
      creativeId: creative.id,
      status: "planned",
      scenes: creative.scenes.map((s) => ({
        sceneId: s.id,
        order: s.order,
        requiresGeneratedVideo: s.requiresGeneratedVideo,
        attempts: [],
      })),
      audioAttempts: [],
      renders: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  private withJobLock<T>(jobId: string, fn: () => Promise<T>): Promise<T> {
    return this.deps.store.getJob(jobId).then((job) => this.campaignLocks.run(job.campaignId, fn));
  }

  private toWorstCaseParams(request: PlanningRequest): PlanningWorstCase {
    return this.deps.planner.worstCase(request);
  }

  /** Preço do modelo que REALMENTE respondeu; se ausente no catálogo, usa o do modelo solicitado e avisa. */
  private llmPricingFor(settings: QualitySettings, servedModel: string): { pricing: LlmPricing; note: string } {
    try {
      return { pricing: resolveLlmPricing({ provider: settings.llm.provider, model: servedModel }, this.deps.pricing), note: "" };
    } catch {
      return {
        pricing: resolveLlmPricing(settings.llm, this.deps.pricing),
        note: ` [preço de ${settings.llm.model}: modelo servido ${servedModel} ausente do catálogo]`,
      };
    }
  }

  /**
   * Registra CADA chamada de LLM: auditoria (LlmCallRecord) + custo real no ledger, a partir do
   * usage devolvido pela API. Chamadas simuladas (mock) são marcadas como simuladas.
   */
  private async recordLlmCalls(
    campaignId: string,
    calls: readonly LlmCallAttempt[],
    settings: QualitySettings,
    rate: number,
    meta: { provider: string; promptId: string; promptVersion: string; simulated: boolean },
  ): Promise<void> {
    const { ids, clock, ledger, llmCallLog } = this.deps;
    for (const call of calls) {
      const llmCallId = ids("llmcall");
      const { pricing, note } = this.llmPricingFor(settings, call.servedModel);
      const lines = llmCallCostLines(pricing, call.usage);
      const costUsd = lines.reduce((acc, l) => acc + l.costUsd, 0);
      if (costUsd > 0 || lines.some((l) => l.quantity > 0)) {
        for (const line of lines) {
          await ledger.record(
            buildActualCost({
              id: ids("cost"),
              campaignId,
              jobId: null,
              creativeId: null,
              sceneId: null,
              attemptId: null,
              llmCallId,
              operation: "campaign_plan",
              category: "llm",
              description: `Planejamento ${meta.promptId}@${meta.promptVersion} — tentativa ${call.attempt} — ${line.label}${note}`,
              pricing: line.pricing,
              usage: line.usage,
              exchangeRate: rate,
              simulated: meta.simulated,
              createdAt: clock(),
            }),
          );
        }
      }
      await llmCallLog.record({
        id: llmCallId,
        campaignId,
        operation: "campaign_plan",
        promptId: meta.promptId,
        promptVersion: meta.promptVersion,
        provider: meta.provider,
        requestedModel: call.requestedModel,
        servedModel: call.servedModel,
        requestId: call.requestId,
        attempt: call.attempt,
        usage: call.usage,
        stopReason: call.stopReason,
        outcome: call.outcome,
        errorSummary: call.errorSummary,
        durationMs: call.durationMs,
        costUsd: roundUsd(costUsd),
        costBrl: roundBrl(usdToBrl(costUsd, rate)),
        exchangeRate: rate,
        simulated: meta.simulated,
        createdAt: clock(),
      });
    }
  }

  /** Custo REAL de todas as execuções de planejamento da campanha (nível campanha). */
  private async planningEntries(campaignId: string): Promise<GenerationCost[]> {
    return (await this.deps.ledger.list({ campaignId, jobId: null })).filter((e) => e.operation === "campaign_plan");
  }

  /** Rateio do custo REAL do planejamento entre os criativos da campanha. */
  private async incurredPlanningShare(campaign: Campaign): Promise<IncurredCost> {
    const entries = await this.planningEntries(campaign.id);
    const shared = Math.max(1, campaign.jobIds.length);
    const usd = entries.reduce((acc, e) => acc + e.costUsd, 0);
    const brl = entries.reduce((acc, e) => acc + e.costBrl, 0);
    return {
      llmCost: { usd: roundUsd(usd / shared), brl: roundBrl(brl / shared) },
      ledgerEntryIds: entries.map((e) => e.id),
      sharedAmongCreatives: shared,
      simulated: entries.some((e) => e.simulated),
    };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Traduz a falha do planner num código estável para a UI (a mensagem crua fica no log/campanha). */
export function planningErrorCode(error: unknown): CampaignErrorCode {
  if (error instanceof PlanningUnavailableError) return "not_configured";
  if (!(error instanceof PlanningError)) return "unknown";
  switch (error.kind) {
    case "retry_exhausted":
    case "invalid_plan":
      return "invalid_response";
    case "stopped":
      return "stopped";
    case "provider_error":
      switch (error.llmErrorKind) {
        case "missing_credentials":
          return "not_configured";
        case "invalid_credentials":
        case "permission_denied":
          return "auth_error";
        case "rate_limited":
          return "rate_limited";
        case "timeout":
          return "timeout";
        case "connection_error":
          return "connection_error";
        default:
          return "provider_error";
      }
  }
}
