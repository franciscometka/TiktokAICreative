import { PlanningError, type CreativePlanner, type PlanningRequest, type PlanningWorstCase } from "@/ai/planner";
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
  IncurredCost,
  ProviderPricing,
} from "@/domain/cost";
import type { CreativePlan, ScenePlan } from "@/domain/creative";
import {
  CampaignRequestSchema,
  type Campaign,
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
import type { AudioProvider } from "@/providers/audio/audio-provider";
import { waitForCompletion, type PollOptions } from "@/providers/poll";
import { ProviderError, type MediaResult, type ProviderJobRef } from "@/providers/types";
import type { VideoProviderFactory } from "@/providers/video";
import type { VideoProvider } from "@/providers/video/video-provider";
import { buildRenderManifest } from "@/render/manifest";
import type { Renderer } from "@/render/renderer";
import type { LlmCallLog } from "@/storage/llm-call-log";
import type { PipelineStore } from "@/storage/pipeline-store";
import { budgetSnapshot, remainingEstimateBrl, sceneEstimateBrl } from "./budget-context";
import {
  activeAttempt,
  assertApprovalValid,
  assertAttemptsAvailable,
  assertCanStartPaidCall,
  assertStatus,
  discardedAttemptIds,
  StaleEstimateError,
  UnexpectedStatusError,
} from "./guards";
import { transitionCampaign, transitionJob } from "./states";

export interface PipelineDeps {
  planner: CreativePlanner;
  videoProviderFactory: VideoProviderFactory;
  audioProviderFactory: AudioProviderFactory;
  renderer: Renderer;
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

export type BudgetExceededOutcome = { kind: "BUDGET_EXCEEDED"; decision: BudgetExceededDecision; job: GenerationJob };
export type ApproveOutcome = { kind: "APPROVED"; job: GenerationJob } | BudgetExceededOutcome;
export type GenerationOutcome =
  | { kind: "COMPLETED"; job: GenerationJob }
  | { kind: "FAILED"; job: GenerationJob; error: string }
  | BudgetExceededOutcome;
export type RegenerationOutcome =
  | { kind: "REGENERATED"; job: GenerationJob }
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

  constructor(private readonly deps: PipelineDeps) {}

  // ---------------------------------------------------------------- planejamento

  /**
   * Produto → plano validado → revisão contra o preset → jobs com estimativa de custo.
   * O custo REAL de cada chamada ao LLM (inclusive tentativas inválidas e falhas) vai para o ledger.
   * Nenhuma chamada paga de MÍDIA acontece aqui.
   */
  async planCampaign(input: CampaignRequest): Promise<Campaign> {
    const { store, clock, ids } = this.deps;
    const request = CampaignRequestSchema.parse(input);
    const settings = resolveQualitySettings(request.quality, request.customSettings);
    const pricing = resolvePricing(settings, this.deps.pricing);
    const rate = (await this.deps.exchangeRates.getUsdBrl()).rate;
    const planningRequest = {
      product: request.product,
      styles: request.styles,
      creativeCount: request.creativeCount,
      settings,
    };

    const worstCaseBrl = usdToBrl(worstCaseLlmCostUsd(pricing.llm, this.toWorstCaseParams(planningRequest)), rate);
    if (toCents(worstCaseBrl) > toCents(request.budget.maxCostPerCampaignBrl)) {
      throw new PlanningBudgetError(
        `O pior caso do planejamento (R$${worstCaseBrl.toFixed(2)}) excede o orçamento da campanha`,
      );
    }

    const createdAt = clock();
    let campaign: Campaign = {
      id: ids("campaign"),
      status: "draft",
      request,
      settings,
      plannerId: this.deps.planner.id,
      jobIds: [],
      createdAt,
      updatedAt: createdAt,
    };
    await store.saveCampaign(campaign);
    campaign = transitionCampaign(campaign, "planning", clock());
    await store.saveCampaign(campaign);

    try {
      const result = await this.deps.planner.plan(planningRequest);
      await this.recordLlmCalls(campaign.id, result.calls, settings, rate, result);

      const review = reviewCampaignPlan(result.plan, settings, pricing, rate);
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
      for (const job of jobs) await this.estimateCost(job.id);
      return campaign;
    } catch (error) {
      if (error instanceof PlanningError) {
        await this.recordLlmCalls(campaign.id, error.calls, settings, rate, error.meta);
      }
      campaign = { ...transitionCampaign(campaign, "failed", clock()), error: messageOf(error) };
      await store.saveCampaign(campaign);
      return campaign;
    }
  }

  // ---------------------------------------------------------------- estimativa e aprovação

  /** Calcula (ou recalcula) a estimativa. Qualquer aprovação anterior deixa de valer. */
  async estimateCost(jobId: string): Promise<GenerationJob> {
    return this.withJobLock(jobId, async () => {
      const { job, campaign, creative, pricing } = await this.load(jobId);
      const rate = (await this.deps.exchangeRates.getUsdBrl()).rate;
      const estimate = estimateCreativeCost({
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
    });
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

  /** Inicia geração de mídia. Exige aprovação válida para a estimativa atual. */
  async generate(jobId: string): Promise<GenerationOutcome> {
    return this.withJobLock(jobId, async () => {
      const ctx = await this.load(jobId);
      assertStatus(ctx.job, "awaiting_approval");
      assertApprovalValid(ctx.job);
      const job = transitionJob(ctx.job, "generating", this.deps.clock());
      await this.deps.store.saveJob(job);
      return this.runGeneration({ ...ctx, job });
    });
  }

  /** Resolve uma pausa por orçamento: cancelar ou autorizar explicitamente o excedente. */
  async resolveBudgetDecision(jobId: string, choice: "cancel" | "authorize"): Promise<GenerationOutcome> {
    return this.withJobLock(jobId, async () => {
      const ctx = await this.load(jobId);
      assertStatus(ctx.job, "budget_exceeded");
      const pending = ctx.job.pendingBudgetDecision;
      if (!pending) throw new UnexpectedStatusError("Job em budget_exceeded sem decisão pendente");

      if (choice === "cancel") {
        const job = { ...transitionJob(ctx.job, "cancelled", this.deps.clock()), pendingBudgetDecision: undefined };
        await this.deps.store.saveJob(job);
        return { kind: "FAILED", job, error: "Cancelado pelo usuário por orçamento" };
      }

      const job: GenerationJob = {
        ...transitionJob(ctx.job, "generating", this.deps.clock()),
        overBudgetAuthorization: authorizeOverBudget(
          pending,
          ctx.campaign.request.budget,
          this.deps.clock(),
          ctx.job.overBudgetAuthorization,
        ),
        pendingBudgetDecision: undefined,
      };
      await this.deps.store.saveJob(job);
      return this.runGeneration({ ...ctx, job });
    });
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
    return this.withJobLock(jobId, async () => {
      const ctx = await this.load(jobId);
      let job = ctx.job;
      assertStatus(job, "completed");
      const scene = ctx.creative.scenes.find((s) => s.id === sceneId);
      const state = job.scenes.find((s) => s.sceneId === sceneId);
      if (!scene || !state) throw new UnexpectedStatusError(`Cena ${sceneId} não pertence ao job`);
      if (!scene.requiresGeneratedVideo) throw new UnexpectedStatusError("Cena não usa vídeo gerado por IA");
      assertAttemptsAvailable(state.attempts, this.deps.maxAttemptsPerScene);

      const additional = sceneEstimateBrl(job, sceneId);
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

      job = transitionJob(job, "generating", this.deps.clock());
      await this.deps.store.saveJob(job);

      const video = this.deps.videoProviderFactory(ctx.pricing.video);
      const result = await this.generateSceneVideo({ ...ctx, job }, scene, video);
      job = result.job;
      if (result.attempt.status === "failed") {
        // A versão anterior da cena continua válida; o vídeo final não muda.
        const error = result.attempt.error ?? "Falha na regeneração";
        job = { ...transitionJob(job, "completed", this.deps.clock()), error };
        await this.deps.store.saveJob(job);
        return { kind: "FAILED", job, error };
      }
      const rendered = await this.render({ ...ctx, job });
      return rendered.kind === "COMPLETED" ? { kind: "REGENERATED", job: rendered.job } : rendered;
    });
  }

  async cancel(jobId: string): Promise<GenerationJob> {
    return this.withJobLock(jobId, async () => {
      const job = await this.deps.store.getJob(jobId);
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

  private async runGeneration(ctx: JobContext): Promise<GenerationOutcome> {
    let job = ctx.job;
    const video = this.deps.videoProviderFactory(ctx.pricing.video);
    const audio = this.deps.audioProviderFactory(ctx.pricing.audio);

    for (const scene of ctx.creative.scenes) {
      if (!scene.requiresGeneratedVideo) continue;
      const state = job.scenes.find((s) => s.sceneId === scene.id);
      if (!state || activeAttempt(state.attempts)) continue;

      const paused = await this.pauseIfOverBudget({ ...ctx, job });
      if (paused) return paused;
      assertAttemptsAvailable(state.attempts, this.deps.maxAttemptsPerScene);

      const result = await this.generateSceneVideo({ ...ctx, job }, scene, video);
      job = result.job;
      if (result.attempt.status === "failed") return this.fail(job, result.attempt.error);
    }

    if (!activeAttempt(job.audioAttempts)) {
      const paused = await this.pauseIfOverBudget({ ...ctx, job });
      if (paused) return paused;
      assertAttemptsAvailable(job.audioAttempts, this.deps.maxAttemptsPerScene);

      const result = await this.generateNarration({ ...ctx, job }, audio);
      job = result.job;
      if (result.attempt.status === "failed") return this.fail(job, result.attempt.error);
    }

    return this.render({ ...ctx, job });
  }

  /** Checagem de orçamento antes de CADA chamada paga, com base no gasto real até aqui. */
  private async pauseIfOverBudget(ctx: JobContext): Promise<BudgetExceededOutcome | undefined> {
    const check = await this.checkJobBudget(ctx, remainingEstimateBrl(ctx.job));
    if (check.kind === "WITHIN_BUDGET") return undefined;
    const job: GenerationJob = {
      ...transitionJob(ctx.job, "budget_exceeded", this.deps.clock()),
      pendingBudgetDecision: check,
    };
    await this.deps.store.saveJob(job);
    return { kind: "BUDGET_EXCEEDED", decision: check, job };
  }

  private async generateSceneVideo(
    ctx: JobContext,
    scene: ScenePlan,
    provider: VideoProvider,
  ): Promise<{ job: GenerationJob; attempt: MediaAttempt }> {
    assertCanStartPaidCall(ctx.job);
    const imageUris = ctx.campaign.request.product.images.map((i) => i.uri);
    return this.executeAttempt(ctx, {
      kind: "video",
      sceneId: scene.id,
      provider: provider.descriptor,
      category: "video",
      operation: "video_generation",
      description: `Vídeo IA — cena ${scene.order + 1}`,
      run: async () => {
        const ref = await provider.generateScene({
          sceneId: scene.id,
          prompt: scene.generationPrompt,
          durationSeconds: scene.estimatedGenerationSeconds,
          aspectRatio: "9:16",
          referenceImageUris: imageUris,
        });
        return this.awaitResult(ref, provider);
      },
    });
  }

  private async generateNarration(
    ctx: JobContext,
    provider: AudioProvider,
  ): Promise<{ job: GenerationJob; attempt: MediaAttempt }> {
    assertCanStartPaidCall(ctx.job);
    const text = ctx.creative.scenes
      .map((s) => s.narration.trim())
      .filter((t) => t.length > 0)
      .join(" ");
    return this.executeAttempt(ctx, {
      kind: "audio",
      sceneId: null,
      provider: provider.descriptor,
      category: "audio",
      operation: "audio_generation",
      description: "Narração (TTS)",
      run: async () => {
        const ref = await provider.generateAudio({ trackId: "narration", text, language: "pt-BR" });
        return this.awaitResult(ref, provider);
      },
    });
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
      attempt = {
        ...base,
        providerJobId: ref.providerJobId,
        status: "succeeded",
        active: true,
        assetUri: result.uri,
        durationSeconds: result.durationSeconds,
      };
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      if (error.billedUsage) await recordCost(error.billedUsage);
      attempt = {
        ...base,
        providerJobId: error.providerJobId ?? null,
        status: "failed",
        active: false,
        error: error.message,
      };
    }

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

  private async render(ctx: JobContext): Promise<GenerationOutcome> {
    let job = transitionJob(ctx.job, "rendering", this.deps.clock());
    await this.deps.store.saveJob(job);
    try {
      const sceneVideos = new Map<string, string>();
      for (const s of job.scenes) {
        const active = activeAttempt(s.attempts);
        if (active?.assetUri) sceneVideos.set(s.sceneId, active.assetUri);
      }
      const narration = activeAttempt(job.audioAttempts);
      const manifest = buildRenderManifest({
        campaignId: ctx.campaign.id,
        plan: ctx.creative,
        product: ctx.campaign.request.product,
        sceneVideos,
        narration: narration?.assetUri
          ? { uri: narration.assetUri, durationSeconds: narration.durationSeconds ?? 0 }
          : undefined,
        outputDir: this.deps.outputDir,
      });
      const result = await this.deps.renderer.render(manifest);
      const rate = (await this.deps.exchangeRates.getUsdBrl()).rate;
      await this.deps.ledger.record(
        buildActualCost({
          id: this.deps.ids("cost"),
          campaignId: ctx.campaign.id,
          jobId: job.id,
          creativeId: ctx.creative.id,
          sceneId: null,
          attemptId: null,
          operation: "render",
          category: "rendering",
          description: "Renderização",
          pricing: ctx.pricing.rendering,
          usage: result.usage,
          exchangeRate: rate,
          simulated: result.isMock,
          createdAt: this.deps.clock(),
        }),
      );
      job = {
        ...transitionJob(job, "completed", this.deps.clock()),
        manifest,
        outputUri: result.outputUri,
        error: undefined,
      };
      await this.deps.store.saveJob(job);
      return { kind: "COMPLETED", job };
    } catch (error) {
      return this.fail(job, messageOf(error));
    }
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

  private async load(jobId: string): Promise<JobContext> {
    const job = await this.deps.store.getJob(jobId);
    const campaign = await this.deps.store.getCampaign(job.campaignId);
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

  /** Rateio do custo REAL do planejamento entre os criativos da campanha. */
  private async incurredPlanningShare(campaign: Campaign): Promise<IncurredCost> {
    const entries = (await this.deps.ledger.list({ campaignId: campaign.id, jobId: null })).filter(
      (e) => e.operation === "campaign_plan",
    );
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
