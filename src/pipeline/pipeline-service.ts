import type { ProjectFacts } from "@/application/project-facts";
import { createHash } from "node:crypto";
import { EXECUTION_STAGES, MOCK_STAGE_MODES, type StageModes, type ExecutionStage, type ExecutionMode, type JobQuote, type StageCapabilities, type StageQuote } from "@/domain/execution";
import type { PreflightCheck } from "@/domain/readiness";
import { assertExecutionFence, ExecutionLeaseLostError, MOCK_BLOCKED, withRealStageAuthorization } from "@/config/execution-policy";
import { RUNWAY_VIDEO } from "@/config/video-models";
import { SIMPLE_QUALITY_PRESETS, SIMPLE_UGC_QUALITY_PRESETS } from "@/config/simple-presets";
import type { PresetQuality } from "@/config/quality-presets";
import type { UgcPricingRefs } from "@/config/ugc-models";
import { approvedReference, fidelityReleasesVideo, isUgcPersonSource, latestReference, UgcRequestSchema, type UgcCharacterIdentity, type UgcEnvironmentChoice, type UgcPresenterChoice } from "@/domain/ugc";
import { resolveUgcIdentity } from "@/config/ugc";
import { findUgcSpeechViolations, speechFitsDuration } from "@/ai/ugc-script";
import { createUgcProviderFactories, type UgcProviderFactories } from "@/providers/ugc";
import type { UgcReferenceProvider, UgcVideoProvider } from "@/providers/ugc/ugc-providers";
import type { UgcAssetStore } from "@/storage/ugc-asset-store";
import { generateUgcReference, generateUgcScene, identityBlockReason, initialUgcState, UgcCostChangedError, UgcFidelityError, UgcIdentityUnsupportedError, UgcPendingError, type UgcFidelityReview, type UgcFlowDeps } from "./ugc-flow";
import { decideFidelity, initialFidelity, missingSpecConfirmations } from "@/domain/fidelity";
import { generatePresenter, presenterPreview, PresenterPendingError, type PresenterFlowDeps } from "./presenter-flow";
import { paidOperationInFlight } from "./paid-operation";
import type { PresenterProvider } from "@/providers/presenter/presenter-provider";
import { readFile } from "node:fs/promises";
import type { AvatarPreset } from "@/domain/presenter";
import { costForUsage } from "@/costs/calculate";
import { presenterBilledSeconds } from "@/config/presenters";
import { RUNWAY_PRESENTER } from "@/config/presenters";
import { alignedPresenterPlan, slicePresenterAudio, type AudioSlicer } from "@/speech/presenter-audio";
import { scenePromptFor } from "@/ai/video-prompt";
import { applyUgcEditorial } from "@/ai/ugc-editorial";
import { applyPresenterOnly } from "@/ai/ugc-presenter-only";
import { applyMasterScript, personaFor } from "@/ai/master-script";
import { DURATION_TARGETS } from "@/config/duration-targets";
import { withTargetDuration } from "@/config/simple-presets";
import { masterAudioSegments, resolveVoiceLock } from "@/domain/video-speech";
import { speechCapabilities } from "@/providers/ugc/ugc-providers";
import type { SpeechCapabilities } from "@/domain/video-speech";
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
import { isGeneratedSource, ScenePlanSchema, type CreativePlan, type ScenePlan, type VisualSource } from "@/domain/creative";
import { getSpeakerProfile } from "@/config/voices";
import {
  CampaignRequestSchema,
  type Campaign,
  type CampaignErrorCode,
  type CampaignRequest,
  type GenerationJob,
  type MediaAttempt,
  type SceneRetryIntent,
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
import { buildEditedRenderManifest } from "@/render/edit-manifest";
import type { EditClip } from "@/render/edit-plan";
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
import { jobKey, planningKey, type ActivitySnapshot, type CampaignLocks, type JobRun, type WorkDispatcher } from "./dispatch";

export interface PipelineDeps {
  planner: CreativePlanner;
  hybrid?: {
    capabilities: StageCapabilities;
    planner: (mode: ExecutionMode) => CreativePlanner;
    audio: (pricing: ProviderPricing, mode: ExecutionMode) => AudioProvider;
    video: (pricing: ProviderPricing, mode: ExecutionMode) => VideoProvider;
    presenter: (pricing: ProviderPricing, mode: ExecutionMode) => PresenterProvider;
    renderer: (mode: ExecutionMode) => Renderer;
    /** Lote 5.5: false = fluxo REAL-only (ALLOW_MOCKS=false). Ausente só em harness de teste explícito. */
    allowMocks?: boolean;
  };
  offlineOnly?: boolean;
  stageDelayMs?: number;
  presenterProviderFactory?: (pricing: ProviderPricing) => PresenterProvider;
  presenterAudioSlicer?: AudioSlicer;
  videoChoice?: PricingRef;
  /** AI UGC por outro provider (ex.: Krea): substitui as refs Google dos presets em projetos NOVOS. */
  ugcChoice?: (quality: PresetQuality) => UgcPricingRefs;
  videoAssets?: VideoAssetStore;
  /** AI UGC (Lote 5.3): factories separadas do Presenter e do vídeo genérico. Padrão: mocks. */
  ugcProviders?: UgcProviderFactories;
  /** Referências pessoa + produto versionadas (UGC_DIR). */
  ugcAssets?: UgcAssetStore;
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
  /** Lote 7: fila durável (cloud). Ausente = trabalho no próprio processo, como no local. */
  dispatcher?: WorkDispatcher;
  /** Lote 7: execuções ativas na fila (queued/running), carregadas por request no cloud. */
  activity?: ActivitySnapshot;
  /** Lote 7: lock por campanha ENTRE processos (advisory lock no Postgres). Ausente = mutex local. */
  locks?: CampaignLocks;
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
  | { kind: "WAITING_STAGE"; job: GenerationJob }
  | { kind: "COMPLETED"; job: GenerationJob }
  /** Narração real bem mais longa que o planejado: espera decisão explícita (nada é regerado sozinho). */
  | { kind: "AUDIO_REVIEW"; job: GenerationJob }
  | { kind: "FAILED"; job: GenerationJob; error: string }
  /** Lote 7 (cloud): a tarefa foi persistida na fila durável; o worker executa. */
  | { kind: "QUEUED"; job: GenerationJob }
  | BudgetExceededOutcome;
export type RegenerationOutcome =
  | { kind: "WAITING_STAGE"; job: GenerationJob }
  | { kind: "REGENERATED"; job: GenerationJob }
  | { kind: "QUEUED"; job: GenerationJob }
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
/** Ordem da autorização única: referência UGC → aprovação → narração → cenas UGC → avatar → cenas → render. */
const JOB_STAGE_ORDER = ["ugc_reference", "narration", "ugc_video", "avatar", "scenes", "render"] as const;

export class PipelineService {
  private readonly hybridInvocations = new Set<string>();
  private readonly campaignLocks: CampaignLocks;
  /**
   * Planejamentos em execução NESTE processo. Não é fila durável: se o processo cair, a campanha
   * fica em "planning" sem entrada aqui e passa a ser vista como interrompida.
   */
  private readonly activePlanning = new Map<string, Promise<Campaign>>();
  /** Gerações/renders em execução NESTE processo (mesma regra: não é fila durável). */
  private readonly activeJobs = new Map<string, Promise<GenerationOutcome>>();
  private readonly renderProgress = new Map<string, RenderProgress>();

  constructor(private readonly deps: PipelineDeps) {
    this.campaignLocks = deps.locks ?? new KeyedMutex();
  }

  // Execução híbrida: uma ação autoriza somente uma unidade da etapa escolhida.
  private fingerprint(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
  getStageCapabilities(): StageCapabilities | undefined { return this.deps.hybrid?.capabilities; }

  /**
   * Lote 6 (Diagnóstico/Voice Lock): matriz de capacidades DECLARADA pelo provider de vídeo UGC
   * que seria usado agora. Sem rede; undefined quando o provider não pode ser criado.
   */
  ugcSpeechMatrix(mode: "mock" | "real" = this.mocksAllowed() ? "mock" : "real"): { provider: string; model: string; audioStrategy: string; capabilities: SpeechCapabilities } | undefined {
    try {
      const refs = this.deps.ugcChoice ? this.deps.ugcChoice("high") : SIMPLE_UGC_QUALITY_PRESETS.high.ugc!;
      const provider = this.ugcFactories().video(this.deps.pricing.requireOne(refs.video), mode);
      return { provider: provider.descriptor.id, model: provider.descriptor.model, audioStrategy: provider.audioStrategy, capabilities: speechCapabilities(provider) };
    } catch {
      return undefined;
    }
  }
  /**
   * Correção Lote 6: o provider de referência que será usado (e o REAL, se configurado) aceita a
   * foto do avatar? Sem rede. Provider não configurado não bloqueia aqui (o preflight da etapa cuida).
   */
  private assertAvatarIdentitySupported(settings: QualitySettings, explicitMode?: "mock" | "real"): void {
    const refs = settings.ugc;
    if (!refs) return;
    const modes = [...new Set([explicitMode ?? (this.mocksAllowed() ? "mock" : "real"), "real"] as const)];
    for (const mode of modes) {
      let provider: UgcReferenceProvider;
      try { provider = this.ugcFactories().reference(this.deps.pricing.requireOne(refs.reference), mode); } catch { continue; }
      if (provider.supportsIdentityReference !== true) throw new UgcIdentityUnsupportedError();
    }
  }

  /** Lote 5.5: MOCK só quando permitido; nunca substitui um provider REAL indisponível. */
  private mocksAllowed(): boolean { return this.deps.hybrid?.allowMocks ?? true; }
  private mockBlocked(stage: ExecutionStage): string {
    const capability = this.deps.hybrid?.capabilities[stage];
    return capability && !capability.available && capability.reason ? `${MOCK_BLOCKED} ${capability.reason}` : MOCK_BLOCKED;
  }
  private assertHybridInvocation(job: GenerationJob, stage: ExecutionStage): void {
    if (job.stageModes?.[stage] === "real" && !this.hybridInvocations.has(job.id)) throw new Error("A etapa REAL exige estimativa e aprovação explícita no painel de etapas.");
  }
  private videoProvider(ctx: JobContext): VideoProvider {
    return this.deps.hybrid ? this.deps.hybrid.video(ctx.pricing.video, ctx.job.stageModes?.scenes ?? "mock") : this.deps.videoProviderFactory(ctx.pricing.video);
  }
  private matchesMode(attempt: MediaAttempt | undefined, mode: ExecutionMode): boolean { return !!attempt && (mode === "mock" || !attempt.isMock); }
  /** Etapa de cada cena gerada: avatar (Presenter), ugc_video (AI UGC) ou scenes (produto/B-roll). */
  private sceneStage(scene: Pick<ScenePlan, "visualSource">): "avatar" | "ugc_video" | "scenes" {
    return scene.visualSource === "presenter" ? "avatar" : isUgcPersonSource(scene.visualSource) ? "ugc_video" : "scenes";
  }
  private failedSceneTarget(ctx: JobContext, sceneId: string) {
    const scene = ctx.creative.scenes.find(item => item.id === sceneId && item.requiresGeneratedVideo);
    const state = ctx.job.scenes.find(item => item.sceneId === sceneId);
    if (!scene || !state) throw new Error(`A cena ${sceneId} não pertence a este job.`);
    const latest = state.attempts.at(-1);
    if (activeAttempt(state.attempts) || !latest || latest.status !== "failed") throw new Error("A cena não está com falha terminal.");
    return { scene, state, latest, stage: this.sceneStage(scene) };
  }
  private ugcFactories(): UgcProviderFactories { return this.deps.ugcProviders ?? createUgcProviderFactories(); }
  private ugcReferenceProvider(ctx: JobContext): UgcReferenceProvider {
    if (!ctx.pricing.ugcReference) throw new Error("Preset sem preço de referência AI UGC.");
    return this.ugcFactories().reference(ctx.pricing.ugcReference, ctx.job.stageModes?.ugc_reference ?? "mock");
  }
  private ugcVideoProvider(ctx: JobContext): UgcVideoProvider {
    if (!ctx.pricing.ugcVideo) throw new Error("Preset sem preço de vídeo AI UGC.");
    return this.ugcFactories().video(ctx.pricing.ugcVideo, ctx.job.stageModes?.ugc_video ?? "mock");
  }
  private async runUgcScene(ctx: JobContext, job: GenerationJob, scene: ScenePlan, mode: ExecutionMode, approvedBrl: number) {
    const rate = (await this.deps.exchangeRates.getUsdBrl()).rate;
    return generateUgcScene(this.ugcDeps(), { campaign: ctx.campaign, plan: ctx.creative, job, scene, provider: this.ugcVideoProvider(ctx), exchangeRate: rate, ...(mode === "real" ? { maxCostUsd: approvedBrl / rate } : {}) });
  }
  private ugcDeps(): UgcFlowDeps { return { ...this.deps, slicer: this.deps.presenterAudioSlicer ?? slicePresenterAudio }; }
  /** AI UGC com fala nativa do vídeo: não há narração TTS separada (D79). */
  private nativeUgcSpeech(job: GenerationJob): boolean { return job.ugc?.audioStrategy === "native_speech"; }
  /** Adoção local explícita dos jobs MOCK de ff176bb, sem recalcular plano/apagar assets. */
  private async adoptOfflineCampaign(campaign: Campaign): Promise<void> {
    if (campaign.executionMode !== "offline") return;
    for (const job of await this.deps.store.listJobs(campaign.id)) {
      if (!job.stageModes) await this.deps.store.saveJob({ ...job, stageModes: { ...MOCK_STAGE_MODES } });
    }
    await this.deps.store.saveCampaign({ ...campaign, executionMode: "hybrid", request: { ...campaign.request, stageModes: campaign.request.stageModes ?? { ...MOCK_STAGE_MODES } } });
  }
  /**
   * Lote 5.5: projeto antigo/MOCK passa a usar REAL nas etapas com provider configurado. Assets MOCK
   * ficam como histórico e nunca alimentam etapas REAL (ex.: referência precisa ser recriada).
   */
  async switchJobToReal(jobId: string): Promise<GenerationJob> {
    const capabilities = this.deps.hybrid?.capabilities;
    if (!capabilities) throw new Error("Fluxo híbrido indisponível");
    const job = await this.getJob(jobId);
    for (const stage of EXECUTION_STAGES) {
      if (stage !== "planning" && capabilities[stage].available && (job.stageModes?.[stage] ?? "mock") !== "real") await this.configureStage(jobId, stage, "real");
    }
    return this.getJob(jobId);
  }
  /**
   * REAL-only: os modos são congelados na criação do projeto. Etapa sem provider naquele momento
   * (ex.: Chrome do Remotion ainda não instalado) ficou MOCK e, com ALLOW_MOCKS=false, bloquearia o
   * job para sempre. Antes da aprovação, adota REAL nas etapas que agora têm provider disponível.
   */
  async adoptAvailableRealStages(jobId: string): Promise<void> {
    const capabilities = this.deps.hybrid?.capabilities;
    if (!capabilities || this.mocksAllowed() || this.isJobActive(jobId)) return;
    const job = await this.getJob(jobId);
    if (!["planned", "cost_estimated", "awaiting_approval"].includes(job.status)) return;
    for (const stage of EXECUTION_STAGES) {
      if (stage !== "planning" && capabilities[stage].available && (job.stageModes?.[stage] ?? "mock") !== "real") await this.configureStage(jobId, stage, "real");
    }
  }
  async configureStage(jobId: string, stage: ExecutionStage, mode: ExecutionMode): Promise<void> {
    if (stage === "planning") throw new Error("O planejamento já produziu este job. Crie uma cópia com ajustes para mudar o roteiro sem invalidar as mídias existentes.");
    await this.withJobLock(jobId, async () => {
      this.assertJobIdle(jobId);
      const ctx = await this.load(jobId);
      if (!this.deps.hybrid || !["hybrid", "offline"].includes(ctx.campaign.executionMode ?? "")) throw new Error("Crie uma cópia híbrida deste projeto.");
      if (mode === "real" && !this.deps.hybrid.capabilities[stage].available) throw new Error(this.deps.hybrid.capabilities[stage].reason);
      if (ctx.job.stageIntents?.some(i => i.state === "running")) throw new Error("Há uma execução pendente/incerta; preserve o modo até reconciliar o provider.");
      const uncertain = ctx.job.presenterTasks?.some(t => t.state === "pending" || t.state === "submitting");
      if (uncertain) throw new Error("Há uma tarefa de avatar pendente; retome a tarefa antes de alterar modos.");
      await this.adoptOfflineCampaign(ctx.campaign);
      const job = { ...ctx.job, stageModes: { ...MOCK_STAGE_MODES, ...ctx.job.stageModes, [stage]: mode }, stageRevision: (ctx.job.stageRevision ?? 0) + 1, updatedAt: this.deps.clock() };
      // Preferência não apaga assets, renders, aprovação anterior ou histórico. Cada nova ação recebe outra cotação.
      await this.deps.store.saveJob(job);
    });
  }
  async quotePlanning(campaignId: string): Promise<StageQuote> {
    const campaign = await this.deps.store.getCampaign(campaignId);
    const mode = campaign.request.stageModes?.planning ?? "mock";
    const pricing = resolvePricing(campaign.settings, this.deps.pricing);
    const estimatedBrl = mode === "real" ? usdToBrl(worstCaseLlmCostUsd(pricing.llm, this.toWorstCaseParams(this.toPlanningRequest(campaign.request, campaign.settings))), (await this.deps.exchangeRates.getUsdBrl()).rate) : 0;
    const entries = await this.planningEntries(campaignId);
    let blocked = mode === "real" && !this.deps.hybrid?.capabilities.planning.available ? this.deps.hybrid?.capabilities.planning.reason ?? "Claude não configurado" : campaign.status === "planned" ? "O plano já existe; crie uma cópia para replanejar." : this.isPlanningActive(campaignId) ? "Planejamento em andamento" : (campaign.planningRuns ?? 0) >= this.deps.maxAttemptsPerScene ? "Limite de tentativas de planejamento atingido" : undefined;
    if (!blocked && mode === "mock" && campaign.status !== "planned" && !this.mocksAllowed()) blocked = this.mockBlocked("planning");
    if (!blocked && mode === "real") {
      const spent = entries.filter(entry => !entry.simulated).reduce((total, entry) => total + entry.costBrl, 0);
      try { await this.assertPlanningFitsBudget(campaign.request, campaign.settings, spent); }
      catch { blocked = "Orçamento insuficiente para o pior caso do planejamento REAL."; }
    }
    const capabilityOk = mode === "mock" || !!this.deps.hybrid?.capabilities.planning.available;
    const attemptsOk = (campaign.planningRuns ?? 0) < this.deps.maxAttemptsPerScene;
    const preflight: PreflightCheck[] = [
      { id: "provider", label: "Provider e configuração", ok: capabilityOk, detail: capabilityOk ? `${mode === "real" ? campaign.settings.llm.provider : "mock"} selecionado e disponível.` : this.deps.hybrid?.capabilities.planning.reason ?? "Provider indisponível." },
      { id: "attempts", label: "Limite de tentativas", ok: attemptsOk, detail: attemptsOk ? `${campaign.planningRuns ?? 0}/${this.deps.maxAttemptsPerScene} tentativas usadas.` : "Limite de tentativas atingido." },
      { id: "budget", label: "Orçamento", ok: !blocked || !blocked.toLowerCase().includes("orçamento"), detail: `Pior caso estimado: R$ ${estimatedBrl.toFixed(2)}. O orçamento será rechecado sob lock.` },
      { id: "approval", label: "Aprovação explícita", ok: true, detail: "O botão de confirmação aprova somente esta execução; nenhuma outra etapa será iniciada." },
    ];
    return { stage: "planning", mode, unit: campaignId, token: this.fingerprint({ campaign, estimatedBrl }), provider: mode === "real" ? campaign.settings.llm.provider : "mock", model: campaign.settings.llm.model, estimatedBrl, actualBrl: entries.filter(e => !e.simulated).reduce((a,e) => a+e.costBrl,0), simulatedBrl: entries.filter(e => e.simulated).reduce((a,e) => a+e.costBrl,0), ready: !blocked, blocked, done: campaign.status === "planned", state: campaign.status === "planned" ? "Concluído" : campaign.status === "draft" ? "Aguardando aprovação" : campaign.status === "planning" ? "Em andamento ou interrompido" : "Falhou", preflight };
  }
  async executePlanning(campaignId: string, token: string) {
    if (!this.deps.hybrid) throw new Error("Fluxo híbrido indisponível");
    const campaign = await this.campaignLocks.run(campaignId, async () => {
      const quote = await this.quotePlanning(campaignId);
      if (quote.token !== token || !quote.ready) throw new Error(quote.blocked ?? "Estimativa alterada; revise e aprove novamente.");
      let campaign = await this.deps.store.getCampaign(campaignId);
      if (campaign.executionMode !== "hybrid" || campaign.status === "planned") throw new Error("Crie uma cópia híbrida para replanejar.");
      const spent = (await this.deps.ledger.list({ campaignId })).filter(e => !e.simulated).reduce((a,e) => a+e.costBrl,0);
      await this.assertPlanningFitsBudget(campaign.request, campaign.settings, spent);
      if (campaign.status === "planning") campaign = this.markInterrupted(campaign);
      campaign = this.beginPlanningRun({ ...campaign, planningApproval: { quoteToken: token, estimatedBrl: quote.estimatedBrl, approvedAt: this.deps.clock() } });
      await this.deps.store.saveCampaign(campaign);
      return campaign;
    });
    return { campaign, completion: (await this.dispatchPlanning(campaign, true)).completion };
  }
  async quoteStage(jobId: string, stage: ExecutionStage, internal = false, regenerate = false, targetSceneId?: string): Promise<StageQuote> {
    if (stage === "planning") return this.quotePlanning((await this.getJob(jobId)).campaignId);
    const ctx = await this.load(jobId); const { job, creative, campaign } = ctx;
    const mode = job.stageModes?.[stage] ?? "mock";
    const narration = activeAttempt(job.audioAttempts);
    const scenes = creative.scenes.filter(s => (stage === "avatar" || stage === "scenes" || stage === "ugc_video") && s.requiresGeneratedVideo && this.sceneStage(s) === stage);
    const scene = regenerate
      ? targetSceneId ? scenes.find(item => item.id === targetSceneId) : scenes[0]
      : scenes.find(s => !this.matchesMode(activeAttempt(job.scenes.find(g => g.sceneId === s.id)?.attempts ?? []), mode));
    let unit = stage === "narration" ? "narration" : stage === "render" ? "render" : stage === "ugc_reference" ? "reference" : scene?.id ?? "done";
    const nativeSkip = stage === "narration" && this.nativeUgcSpeech(job);
    // Em REAL, uma referência MOCK aprovada (histórico) não conta: a etapa precisa ser recriada.
    const approvedRef = approvedReference(job.ugc);
    const referenceDone = stage === "ugc_reference" && (!job.ugc || !!approvedRef && (mode === "mock" || !approvedRef.isMock));
    const done = !regenerate && (nativeSkip || referenceDone || stage !== "ugc_reference" && (stage === "narration" ? this.matchesMode(narration, mode) : stage === "render" ? job.status === "completed" && !job.renderStale && job.renders.some(r => r.status === "completed" && (mode === "mock" || !r.isMock)) : !scene));
    let model = stage === "narration" ? ctx.pricing.audio.model : stage === "render" ? ctx.pricing.rendering.model : stage === "avatar" ? RUNWAY_PRESENTER.model : stage === "ugc_reference" ? ctx.pricing.ugcReference?.model ?? "—" : stage === "ugc_video" ? ctx.pricing.ugcVideo?.model ?? "—" : ctx.pricing.video.model;
    let provider = mode === "mock" ? "mock" : stage === "narration" ? ctx.pricing.audio.provider : stage === "render" ? "remotion" : stage === "ugc_reference" ? ctx.pricing.ugcReference?.provider ?? "google" : stage === "ugc_video" ? ctx.pricing.ugcVideo?.provider ?? "google" : "runway";
    let awaitingReview = false;
    let budgetDecision: BudgetExceededDecision | undefined;
    let estimatedBrl = 0; let blocked: string | undefined;
    if (!this.deps.hybrid || !["hybrid", "offline"].includes(campaign.executionMode ?? "")) blocked = "Projeto anterior: crie uma cópia híbrida para continuar.";
    else if (mode === "real" && !this.deps.hybrid.capabilities[stage].available) blocked = this.deps.hybrid.capabilities[stage].reason;
    else if (mode === "mock" && !done && !this.mocksAllowed()) blocked = this.mockBlocked(stage);
    else if (!internal && this.isJobActive(jobId)) blocked = "Etapa em andamento";
    else if (job.status === "cancelled") blocked = "Job cancelado";
    try {
      if (stage === "ugc_reference") {
        if (job.ugc && !referenceDone) {
          const state = job.ugc;
          const latest = latestReference(state);
          const current = latest && latest.identityId === state.identity.id && latest.identityRevision === state.identity.revision ? latest : undefined;
          if (current?.state === "succeeded" && current.review === "pending" && (mode === "mock" || !current.isMock)) {
            awaitingReview = true;
            blocked ??= "Aprove a referência: esta será a pessoa apresentando seu produto.";
          }
          if (current && (current.state === "submitting" || current.state === "pending" || current.state === "uncertain")) {
            if (current.providerJobId && current.state !== "uncertain") unit = `reference:resume:${current.providerJobId}`;
            else if (current.provider === "krea" && current.state === "submitting" && current.metadata?.paidSubmissionStarted !== true) unit = `reference:prepare:${current.id}`;
            else blocked ??= "Envio anterior da referência incerto e sem operation ID. Sem reenvio automático; confira o provider antes de continuar.";
          }
          const identityAttempts = state.references.filter(reference => reference.identityId === state.identity.id && reference.identityRevision === state.identity.revision).length;
          if (!awaitingReview && identityAttempts >= this.deps.maxAttemptsPerScene) blocked ??= "Limite de tentativas da referência UGC atingido";
          const reference = this.ugcReferenceProvider(ctx); model = reference.descriptor.model;
          // Avatar salvo com foto: o provider precisa aceitar a foto; senão, nada a autorizar.
          const identityBlock = identityBlockReason(state.identity, reference);
          if (identityBlock) blocked = identityBlock;
          estimatedBrl = reference.estimateCost().costUsd * (await this.deps.exchangeRates.getUsdBrl()).rate;
        }
      } else if (stage === "narration" && nativeSkip) {
        // Fala nativa do vídeo AI UGC: nenhuma narração TTS a gerar.
      } else if (stage === "narration") {
        const attempts = job.audioAttempts;
        if (!done && attempts.length >= this.deps.maxAttemptsPerScene) blocked ??= "Limite de tentativas da narração atingido";
        if (!done && job.presenterTasks?.some(t => !t.isMock && (t.state === "succeeded" || t.state === "pending" || t.state === "submitting"))) blocked ??= "A narração está vinculada ao avatar. Crie uma cópia para mudar a fala preservando a sincronização.";
        const audio = this.createAudioProvider(ctx); if (!audio.ok) throw new Error(audio.error);
        const script = buildNarrationScript(creative);
        const quote = audio.provider.estimateCost({ trackId: "narration", text: script.spoken, language: "pt-BR", speakerProfileId: getSpeakerProfile(campaign.request.speakerProfileId).id });
        estimatedBrl = quote.costUsd * (await this.deps.exchangeRates.getUsdBrl()).rate;
      } else if (scene) {
        const attempts = job.scenes.find(s => s.sceneId === scene.id)!.attempts;
        const pending = job.presenterTasks?.find(t => t.sceneId === scene.id && (t.state === "pending" || t.state === "submitting"));
        const pendingUgc = job.ugcVideoOperations?.findLast(operation => operation.sceneId === scene.id && operation.state !== "settled");
        if (!pending && !pendingUgc && !job.videoTasks?.some(t => t.sceneId === scene.id && t.state === "pending") && attempts.length >= this.deps.maxAttemptsPerScene) blocked ??= "Limite de tentativas da cena atingido";
        if (stage === "avatar") {
          if (!campaign.request.presenterPresetId) blocked ??= "Selecione um avatar ao criar o projeto.";
          if (!narration) blocked ??= "Execute a narração primeiro.";
          else {
            const preview = await presenterPreview(this.deps, campaign, creative, job, scene, mode === "mock");
            estimatedBrl = this.presenterProvider(ctx).estimateCost(preview.durationSeconds).costUsd * (await this.deps.exchangeRates.getUsdBrl()).rate;
          }
          if (pending?.state === "submitting" && !pending.providerJobId) blocked ??= "Envio anterior incerto: sem reenvio automático; confira a tarefa no provider.";
          if (pending?.providerJobId) unit = `${scene.id}:resume:${pending.providerJobId}`;
        } else if (stage === "ugc_video") {
          if (!approvedReference(job.ugc)) blocked ??= "Nenhuma cena UGC é gerada antes de uma referência aprovada.";
          else if (mode === "real" && approvedReference(job.ugc)!.isMock) blocked ??= "A referência aprovada é uma simulação (MOCK): gere uma referência real antes das cenas UGC.";
          else if (!fidelityReleasesVideo(approvedReference(job.ugc), mode)) blocked ??= "Verifique se produto, logo, textos e especificações continuam fiéis e confirme a fidelidade da referência.";
          if (job.ugc?.audioStrategy === "external_lipsync" && !narration) blocked ??= "Execute a narração primeiro (lip sync).";
          if ((pendingUgc?.state === "uncertain" || pendingUgc?.state === "submitting" && (pendingUgc.provider !== "krea" || pendingUgc.metadata?.paidSubmissionStarted === true)) && !pendingUgc.providerOperationId) {
            blocked ??= "Envio UGC anterior incerto: sem operation ID, não haverá reenvio automático.";
          } else if (pendingUgc?.provider === "krea" && pendingUgc.state === "submitting" && !pendingUgc.providerOperationId) unit = `${scene.id}:prepare:${pendingUgc.attemptId}`;
          if (pendingUgc?.providerOperationId) unit = `${scene.id}:resume:${pendingUgc.providerOperationId}`;
          const ugcVideo = this.ugcVideoProvider(ctx); model = ugcVideo.descriptor.model;
          estimatedBrl = ugcVideo.estimateCost(scene.estimatedGenerationSeconds).costUsd * (await this.deps.exchangeRates.getUsdBrl()).rate;
        } else {
          const video = this.videoProvider(ctx); model = video.descriptor.model; provider = video.descriptor.id;
          estimatedBrl = video.estimateCost(this.videoRequest(ctx, scene)).costUsd * (await this.deps.exchangeRates.getUsdBrl()).rate;
          if (mode === "real") await video.validateRequest?.(this.videoRequest(ctx, scene));
          const uncertain = job.videoTasks?.findLast(t => t.sceneId === scene.id && (t.state === "pending" || t.state === "submitting" || !t.state && !attempts.some(a => a.providerJobId === t.providerJobId)));
          if (uncertain && uncertain.state !== "pending") blocked ??= "Geração anterior de vídeo incerta. Não será reenviada; confira a tarefa no provider antes de continuar.";
          if (uncertain?.state === "pending") unit = `${scene.id}:resume:${uncertain.providerJobId}`;
        }
      } else if (stage === "render") {
        if (!mediaComplete(job)) blocked ??= "Conclua narração e cenas primeiro.";
        if (creative.scenes.some(s => s.requiresGeneratedVideo && !this.matchesMode(activeAttempt(job.scenes.find(g => g.sceneId === s.id)?.attempts ?? []), job.stageModes?.[this.sceneStage(s)] ?? "mock")) || (!this.nativeUgcSpeech(job) && !this.matchesMode(narration, job.stageModes?.narration ?? "mock"))) blocked ??= "Há etapas selecionadas em REAL ainda não executadas.";
        if (narration?.narration?.fit?.action === "review" && !narration.narration.reviewAcceptedAt) blocked ??= "Revise e aceite a duração da narração antes do render.";
      }
    } catch (error) { blocked ??= messageOf(error); }
    if (job.stageIntents?.some(i => i.stage === stage && i.state === "running")
      && !(stage === "avatar" && job.presenterTasks?.some(t => t.state === "pending" && t.providerJobId))
      && !(stage === "scenes" && job.videoTasks?.some(t => t.state === "pending" && t.providerJobId))
      && !(stage === "ugc_reference" && latestReference(job.ugc)?.providerJobId && ["submitting", "pending"].includes(latestReference(job.ugc)!.state))
      && !(stage === "ugc_video" && job.ugcVideoOperations?.some(operation => operation.state === "pending" && operation.providerOperationId))) {
      blocked ??= "Etapa anterior interrompida com possível cobrança. Sem reenvio: confira o provider e preserve o ledger antes de uma nova execução.";
    }
    if (regenerate && (stage === "scenes" || stage === "avatar" || stage === "ugc_video") && !scene) blocked ??= "Não há cenas desta etapa neste job.";
    if (done) estimatedBrl = 0;
    if (mode === "mock") estimatedBrl = 0;
    if (!done && !blocked) { const budget = await this.checkJobBudget(ctx, estimatedBrl); if (budget.kind === "BUDGET_EXCEEDED") { budgetDecision = budget; blocked = `Orçamento insuficiente: total R$${budget.newEstimatedTotalBrl.toFixed(2)}; ajuste o orçamento em uma cópia ou use a decisão de orçamento existente.`; } }
    const categories: CostCategory[] = stage === "narration" ? ["audio"] : stage === "render" ? ["rendering"] : stage === "ugc_reference" ? ["ugc_reference"] : stage === "ugc_video" ? ["ugc_scene"] : ["video", "broll"];
    const sceneIds = new Set(scenes.map(s => s.id));
    const perScene = stage === "scenes" || stage === "avatar" || stage === "ugc_video";
    const entries = (await this.deps.ledger.list({ jobId })).filter(e => categories.includes(e.category) && (!perScene || !!e.sceneId && sceneIds.has(e.sceneId)));
    const capabilityOk = mode === "mock" || !!this.deps.hybrid?.capabilities[stage].available;
    const attemptsUsed = stage === "narration" ? job.audioAttempts.length : stage === "ugc_reference" ? job.ugc?.references.filter(reference => reference.identityId === job.ugc?.identity.id && reference.identityRevision === job.ugc?.identity.revision).length ?? 0 : scene ? job.scenes.find(s => s.sceneId === scene.id)?.attempts.length ?? 0 : 0;
    const attemptsOk = done || attemptsUsed < this.deps.maxAttemptsPerScene;
    const hasRealNarration = !!narration && !narration.isMock && !!narration.assetUri && !!narration.narration?.timingUri;
    const assetsOk = stage === "ugc_reference" ? !!job.ugc || !creative.scenes.some(s => isUgcPersonSource(s.visualSource)) : stage !== "scenes" || mode === "mock" || (!!scene && campaign.request.product.images.length > 0 && !blocked?.toLowerCase().includes("imagem"));
    const durationLimit = stage === "avatar" ? 30 : stage === "ugc_video" ? 15 : 10;
    const durationOk = !scene || scene.estimatedGenerationSeconds > 0 && scene.estimatedGenerationSeconds <= durationLimit || stage === "render" || stage === "narration";
    const dependenciesOk = stage === "ugc_video" ? !!approvedReference(job.ugc) && (job.ugc?.audioStrategy !== "external_lipsync" || !!narration) : stage === "avatar" ? !!campaign.request.presenterPresetId && (mode === "mock" ? !!narration : hasRealNarration) : stage === "render" ? mediaComplete(job) : true;
    const preflight: PreflightCheck[] = [
      { id: "provider", label: "Provider e configuração", ok: capabilityOk, detail: capabilityOk ? `${provider} · ${model} disponível para ${mode.toUpperCase()}.` : this.deps.hybrid?.capabilities[stage].reason ?? "Provider indisponível." },
      { id: "assets", label: "Assets exigidos", ok: assetsOk, detail: stage === "scenes" ? (assetsOk ? "Imagem local e pedido da cena passaram pela validação sem rede." : "A cena REAL exige uma imagem local válida do produto.") : "Nenhum asset de entrada adicional falta nesta etapa." },
      { id: "dependencies", label: "Dependências da etapa", ok: dependenciesOk, detail: stage === "avatar" ? (dependenciesOk ? "Avatar selecionado e narração/alignment compatíveis." : "Selecione avatar e conclua a narração REAL com alignment.") : stage === "render" ? (dependenciesOk ? "Mídias completas e render atualizado." : "Conclua narração, avatar e cenas antes do render.") : "Dependências anteriores atendidas." },
      { id: "duration", label: "Duração", ok: durationOk, detail: scene ? `${scene.estimatedGenerationSeconds}s editoriais; o provider validará a duração comprada antes do POST.` : "Duração compatível com esta etapa." },
      { id: "attempts", label: "Limite de tentativas", ok: attemptsOk, detail: done ? "Etapa concluída." : `${attemptsUsed}/${this.deps.maxAttemptsPerScene} tentativas usadas nesta unidade.` },
      { id: "budget", label: "Orçamento", ok: !budgetDecision, detail: budgetDecision ? `A execução excede o limite de R$ ${budgetDecision.budgetBrl.toFixed(2)} e exige decisão própria.` : `Estimativa R$ ${estimatedBrl.toFixed(2)}; será rechecada sob lock.` },
      { id: "approval", label: "Aprovação explícita", ok: true, detail: "A confirmação registra cotação, unidade, provider e modelo; autoriza somente uma criação." },
    ];
    return { awaitingReview, regenerate, budgetDecision, stage, mode, unit, token: this.fingerprint({ job, stage, mode, unit, estimatedBrl, model, provider, budgetDecision, regenerate }), provider, model, estimatedBrl, actualBrl: entries.filter(e => !e.simulated).reduce((a,e) => a+e.costBrl,0), simulatedBrl: entries.filter(e => e.simulated).reduce((a,e) => a+e.costBrl,0), ready: !blocked && !done, blocked, done, state: this.isJobActive(jobId) && job.currentStage === stage ? "Em andamento" : nativeSkip ? "Fala nativa do vídeo UGC" : done ? "Concluído" : awaitingReview ? "Aguardando aprovação visual" : blocked ? "Bloqueado" : "Aguardando ação explícita", preflight };
  }

  /** Nova decisão de gasto para recuperar UMA cena cuja tentativa terminal falhou. */
  async quoteFailedSceneRetry(jobId: string, sceneId: string): Promise<StageQuote> {
    const ctx = await this.load(jobId);
    const scene = ctx.creative.scenes.find(item => item.id === sceneId && item.requiresGeneratedVideo);
    const state = ctx.job.scenes.find(item => item.sceneId === sceneId);
    if (!scene || !state) throw new Error(`A cena ${sceneId} não pertence a este job.`);
    const quote = await this.quoteStage(jobId, this.sceneStage(scene), false, true, sceneId);
    let failed;
    try { failed = this.failedSceneTarget(ctx, sceneId); }
    catch (error) { return { ...quote, ready: false, blocked: messageOf(error), state: "Bloqueado" }; }
    const uncertain = paidOperationInFlight(ctx.job);
    if (uncertain) {
      return { ...quote, ready: false, blocked: `Geração pausada por segurança: ${uncertain}.`, state: "Bloqueado" };
    }
    const pending = ctx.job.sceneRetryIntents?.findLast(intent => intent.sceneId === sceneId && intent.failedAttemptId === failed.latest.id && intent.state !== "settled");
    if (pending) {
      const active = this.isJobActive(jobId);
      return {
        ...quote,
        stage: pending.stage,
        mode: pending.mode,
        unit: pending.sceneId,
        token: pending.quoteToken,
        provider: pending.provider,
        model: pending.model,
        estimatedBrl: pending.estimatedBrl,
        ready: !active,
        blocked: active ? "A tentativa autorizada já está na fila ou em execução." : undefined,
        done: false,
        state: active ? "Em andamento" : "Autorizada; pronta para retomar",
      };
    }
    return quote;
  }

  /** Aprova e agenda UMA tentativa da cena. A intent durável nasce no mesmo save da aprovação. */
  async retryFailedScene(jobId: string, sceneId: string, token: string): Promise<{ job: GenerationJob; completion: Promise<GenerationOutcome> }> {
    const prepared = await this.withJobLock(jobId, async () => {
      let job = await this.getJob(jobId);
      const existing = job.sceneRetryIntents?.find(intent => intent.sceneId === sceneId && intent.quoteToken === token);
      if (existing) return { job, intent: existing, dispatch: existing.state !== "settled" && !this.isJobActive(jobId) };
      this.assertJobIdle(jobId);
      const quote = await this.quoteFailedSceneRetry(jobId, sceneId);
      if (quote.token !== token || !quote.ready) throw new Error(quote.blocked ?? "A cotação mudou; revise e aprove novamente.");
      const ctx = await this.load(jobId);
      const target = this.failedSceneTarget(ctx, sceneId);
      if (paidOperationInFlight(job)) throw new Error("Geração pausada por segurança: existe uma operação paga sem confirmação.");
      if (!job.estimate) throw new Error("Job sem estimativa");
      const estimateId = job.estimate.id;
      const budget = await this.checkJobBudget(ctx, quote.estimatedBrl);
      if (budget.kind === "BUDGET_EXCEEDED") throw new Error("O retry excede o orçamento atual; revise uma nova cotação.");
      if (job.status === "failed") { job = transitionJob(job, "cost_estimated", this.deps.clock()); job = transitionJob(job, "awaiting_approval", this.deps.clock()); }
      if (job.status === "cost_estimated") job = transitionJob(job, "awaiting_approval", this.deps.clock());
      const now = this.deps.clock();
      const intent: SceneRetryIntent = {
        id: `scene_retry_${token.slice(0, 32)}`,
        sceneId,
        stage: target.stage,
        quoteToken: token,
        failedAttemptId: target.latest.id,
        nextAttemptNumber: target.state.attempts.length + 1,
        estimateId,
        storyboardRevision: job.storyboardRevision ?? 0,
        stageRevision: job.stageRevision ?? 0,
        mode: quote.mode,
        provider: quote.provider,
        model: quote.model,
        estimatedBrl: quote.estimatedBrl,
        state: "authorized",
        createdAt: now,
        updatedAt: now,
      };
      job = {
        ...job,
        approval: { estimateId, approvedTotalBrl: quote.estimatedBrl, overBudget: false, approvedAt: now },
        stageApprovals: [...(job.stageApprovals ?? []), { stage: target.stage, mode: quote.mode, provider: quote.provider, model: quote.model, unit: sceneId, quoteToken: token, estimatedBrl: quote.estimatedBrl, approvedAt: now }],
        sceneRetryIntents: [...(job.sceneRetryIntents ?? []), intent],
        waitingForStage: undefined,
        error: undefined,
      };
      if (job.status === "awaiting_approval" || job.status === "completed" || job.status === "budget_exceeded") job = transitionJob(job, "generating", now);
      if (job.status !== "generating") throw new Error("Resolva a revisão/orçamento antes de tentar esta cena.");
      await this.deps.store.saveJob(job);
      return { job, intent, dispatch: true };
    });
    if (!prepared.dispatch) return { job: prepared.job, completion: Promise.resolve(this.outcomeForSettledRetry(prepared.job)) };
    const dispatched = await this.dispatchJob(jobId, { kind: "scene_retry", retryIntentId: prepared.intent.id });
    if (this.deps.dispatcher) {
      await this.withJobLock(jobId, async () => {
        const current = await this.getJob(jobId); const now = this.deps.clock();
        await this.deps.store.saveJob({ ...current, sceneRetryIntents: current.sceneRetryIntents?.map(intent => intent.id === prepared.intent.id && intent.state === "authorized" ? { ...intent, state: "queued" as const, updatedAt: now } : intent) });
      });
    }
    return { job: prepared.job, completion: dispatched.completion };
  }

  private outcomeForSettledRetry(job: GenerationJob): GenerationOutcome {
    if (job.status === "completed") return { kind: "COMPLETED", job };
    if (job.status === "failed") return { kind: "FAILED", job, error: job.error ?? "A tentativa falhou." };
    return { kind: "WAITING_STAGE", job };
  }

  private async performSceneRetryIntent(jobId: string, retryIntentId: string): Promise<GenerationOutcome> {
    const ctx = await this.load(jobId);
    const intent = ctx.job.sceneRetryIntents?.find(item => item.id === retryIntentId);
    if (!intent) throw new Error("Intenção de retry não encontrada.");
    if (intent.state === "settled") return this.outcomeForSettledRetry(ctx.job);
    // Queda depois da tentativa persistida e antes do settle: reconcilia pela identidade da intent, sem reenviar.
    const attempts = ctx.job.scenes.find(item => item.sceneId === intent.sceneId)?.attempts ?? [];
    const persisted = attempts.find(attempt => attempt.attemptNumber === intent.nextAttemptNumber);
    if (persisted && attempts[intent.nextAttemptNumber - 2]?.id === intent.failedAttemptId) {
      return this.settleSceneRetryIntent(jobId, retryIntentId, persisted.status === "failed"
        ? { kind: "FAILED", job: ctx.job, error: persisted.error ?? ctx.job.error ?? "A tentativa falhou." }
        : { kind: "WAITING_STAGE", job: ctx.job });
    }
    const target = this.failedSceneTarget(ctx, intent.sceneId);
    const quote = await this.quoteStage(jobId, target.stage, true, true, intent.sceneId);
    const unchanged = target.latest.id === intent.failedAttemptId
      && target.state.attempts.length + 1 === intent.nextAttemptNumber
      && ctx.job.estimate?.id === intent.estimateId
      && (ctx.job.storyboardRevision ?? 0) === intent.storyboardRevision
      && (ctx.job.stageRevision ?? 0) === intent.stageRevision
      && quote.stage === intent.stage && quote.mode === intent.mode
      && quote.provider === intent.provider && quote.model === intent.model
      && toCents(quote.estimatedBrl) === toCents(intent.estimatedBrl);
    if (!unchanged || quote.blocked || quote.done) {
      await assertExecutionFence();
      const reason = quote.blocked ?? "A cotação mudou; revise e aprove novamente.";
      const blocked = await this.withJobLock(jobId, async () => {
        const current = await this.getJob(jobId); const now = this.deps.clock();
        const terminal = current.status === "generating" || current.status === "rendering" ? transitionJob(current, "failed", now) : current;
        const next = { ...terminal, sceneRetryIntents: terminal.sceneRetryIntents?.map(item => item.id === retryIntentId ? { ...item, state: "settled" as const, outcome: "blocked" as const, updatedAt: now } : item), error: reason };
        await this.deps.store.saveJob(next); return next;
      });
      return { kind: "FAILED", job: blocked, error: reason };
    }
    await assertExecutionFence();
    await this.withJobLock(jobId, async () => {
      const current = await this.getJob(jobId); const now = this.deps.clock();
      await this.deps.store.saveJob({ ...current, sceneRetryIntents: current.sceneRetryIntents?.map(item => item.id === retryIntentId ? { ...item, state: "running" as const, updatedAt: now } : item) });
    });
    return this.settleSceneRetryIntent(jobId, retryIntentId, await this.performHybridStage(jobId, intent.stage, true, intent.sceneId));
  }

  /** Trabalho gratuito restante (render) + settle da intent conforme o resultado real da tentativa. */
  private async settleSceneRetryIntent(jobId: string, retryIntentId: string, result: GenerationOutcome): Promise<GenerationOutcome> {
    let outcome = result;
    if (outcome.kind === "WAITING_STAGE") {
      const render = await this.quoteStage(jobId, "render", true);
      if (render.ready && render.estimatedBrl === 0) {
        const prepared = await this.prepareStage(jobId, "render", render.token, {}, true);
        if (!prepared.budgetStillBlocked) outcome = await this.performHybridStage(jobId, "render");
      }
    }
    const latest = await this.getJob(jobId);
    if (!paidOperationInFlight(latest)) {
      await assertExecutionFence();
      const now = this.deps.clock();
      // A intent liquida o retry da cena (`result`), não o render grátis encadeado: falha do render fica só no job.
      const settled = { ...latest, sceneRetryIntents: latest.sceneRetryIntents?.map(item => item.id === retryIntentId ? { ...item, state: "settled" as const, outcome: result.kind === "FAILED" ? "failed" as const : "succeeded" as const, updatedAt: now } : item) };
      await this.deps.store.saveJob(settled);
      outcome = { ...outcome, job: settled };
    }
    return outcome;
  }

  /** Cotação única do fluxo simples. Conservadora: qualquer etapa REAL reserva o futuro inteiro da estimativa. */
  async quoteJob(jobId: string): Promise<JobQuote> {
    const ctx = await this.load(jobId);
    const stages = await Promise.all(JOB_STAGE_ORDER.map(stage => this.quoteStage(jobId, stage)));
    const entries = (await this.deps.ledger.list({ jobId })).filter(entry => !entry.simulated);
    const actualBrl = roundBrl(entries.reduce((total, entry) => total + entry.costBrl, 0));
    const hasRealStage = JOB_STAGE_ORDER.some(stage => ctx.job.stageModes?.[stage] === 'real');
    const stageEstimate = roundBrl(stages.reduce((total, quote) => total + quote.estimatedBrl, 0));
    // A estimativa histórica do job não incluía o custo específico do provider de
    // presenter. Reserve todas as cenas de avatar ainda não geradas para que o teto
    // único não aumente no meio da execução automática.
    let presenterReserve = 0;
    if (ctx.job.stageModes?.avatar === 'real') {
      const rate = (await this.deps.exchangeRates.getUsdBrl()).rate;
      const presenter = this.presenterProvider(ctx);
      for (const scene of ctx.creative.scenes.filter(item => item.visualSource === 'presenter' && item.requiresGeneratedVideo)) {
        const state = ctx.job.scenes.find(item => item.sceneId === scene.id);
        if (!this.matchesMode(activeAttempt(state?.attempts ?? []), 'real')) {
          presenterReserve += presenter.estimateCost(scene.duration).costUsd * rate;
        }
      }
    }
    const conservativeEstimate = hasRealStage
      ? roundBrl(Math.max(stageEstimate, ctx.job.estimate?.estimatedAdditionalBrl ?? 0) + presenterReserve)
      : 0;
    const maximumAuthorizedBrl = roundBrl(actualBrl + conservativeEstimate);
    let blocked: string | undefined;
    if (!this.deps.hybrid || !['hybrid', 'offline'].includes(ctx.campaign.executionMode ?? '')) blocked = 'Crie uma cópia no fluxo atual para usar a geração automática.';
    else if (this.isJobActive(jobId)) blocked = 'O job já está em execução.';
    else if (ctx.job.status === 'cancelled') blocked = 'O job foi cancelado.';
    else if (!ctx.job.estimate) blocked = 'A estimativa do job ainda não está pronta.';
    else {
      const unavailable = JOB_STAGE_ORDER.find(stage =>
        ctx.job.stageModes?.[stage] === 'real' && !this.deps.hybrid?.capabilities[stage].available,
      );
      if (unavailable) blocked = this.deps.hybrid.capabilities[unavailable].reason;
    }
    const token = this.fingerprint({
      jobId,
      estimateId: ctx.job.estimate?.id,
      stageModes: ctx.job.stageModes,
      stageRevision: ctx.job.stageRevision,
      storyboardRevision: ctx.job.storyboardRevision,
      maximumAuthorizedBrl,
      actualBrl,
      units: stages.map(({ stage, mode, unit, provider, model }) => ({ stage, mode, unit, provider, model })),
    });
    // Readiness geral do job: a primeira etapa pendente que bloqueia o fluxo (ex.: MOCK desabilitado).
    const blocker = stages.find(q => !q.done && q.blocked && !q.awaitingReview);
    const mockStage = this.mocksAllowed() ? undefined : stages.find(q => q.mode === "mock" && !q.done);
    if (!blocked && mockStage) blocked = `Etapa ${mockStage.stage} bloqueada: ${mockStage.blocked ?? MOCK_BLOCKED}`;
    const blockingStage = mockStage ? { stage: mockStage.stage, reason: mockStage.blocked ?? MOCK_BLOCKED } : blocker ? { stage: blocker.stage, reason: blocker.blocked! } : undefined;
    return { jobId, token, estimatedBrl: conservativeEstimate, maximumAuthorizedBrl, actualBrl, ready: !blocked, blocked, stages, ...(blockingStage ? { blockingStage } : {}) };
  }

  /**
   * Aprova o teto do job inteiro e inicia a sequência. Cada provider continua recebendo uma
   * autorização efêmera por chamada; a sequência para no primeiro erro, incerteza ou aumento.
   */
  async authorizeAndRunJob(jobId: string, token: string) {
    const prepared = await this.withJobLock(jobId, async () => {
      this.assertJobIdle(jobId);
      const quote = await this.quoteJob(jobId);
      if (quote.token !== token || !quote.ready) throw new Error(quote.blocked ?? 'A estimativa mudou; revise o novo teto antes de gerar.');
      let job = await this.getJob(jobId);
      if (!job.estimate) throw new Error('Job sem estimativa.');
      const estimateId = job.estimate.id;
      const budget = await this.checkJobBudget(await this.load(jobId), quote.estimatedBrl);
      if (budget.kind === 'BUDGET_EXCEEDED') throw new Error(`O teto de R$ ${quote.maximumAuthorizedBrl.toFixed(2)} excede o orçamento configurado.`);
      if (job.status === 'planned') job = await this.estimateJob(job.id);
      if (job.status === 'cost_estimated') job = transitionJob(job, 'awaiting_approval', this.deps.clock());
      if (job.status === 'failed') {
        job = transitionJob(job, 'cost_estimated', this.deps.clock());
        job = transitionJob(job, 'awaiting_approval', this.deps.clock());
      }
      job = {
        ...job,
        approval: { estimateId, approvedTotalBrl: quote.maximumAuthorizedBrl, overBudget: false, approvedAt: this.deps.clock() },
        jobAuthorization: {
          quoteToken: token,
          estimatedBrl: quote.estimatedBrl,
          maximumAuthorizedBrl: quote.maximumAuthorizedBrl,
          baselineActualBrl: quote.actualBrl,
          status: 'active',
          approvedAt: this.deps.clock(),
        },
        waitingForStage: undefined,
        error: undefined,
      };
      if (job.status === 'awaiting_approval' || job.status === 'completed' || job.status === 'budget_exceeded') job = transitionJob(job, 'generating', this.deps.clock());
      await this.deps.store.saveJob(job);
      return job;
    });
    return { job: prepared, completion: (await this.dispatchJob(jobId, { kind: "authorized" })).completion };
  }

  private async pauseAuthorizedJob(jobId: string, reason: string, waitingFor?: GenerationJob["waitingForStage"]): Promise<GenerationOutcome> {
    const job = await this.withJobLock(jobId, async () => {
      await assertExecutionFence();
      const current = await this.getJob(jobId);
      const next = {
        ...current,
        jobAuthorization: current.jobAuthorization ? { ...current.jobAuthorization, status: 'paused' as const, pausedReason: reason } : undefined,
        waitingForStage: waitingFor ?? current.currentStage,
        // Revisão visual não é erro: o motivo fica só na autorização.
        error: waitingFor === "ugc_reference" ? undefined : reason,
        updatedAt: this.deps.clock(),
      };
      await this.deps.store.saveJob(next);
      return next;
    });
    return { kind: 'WAITING_STAGE', job };
  }

  private async runAuthorizedJob(jobId: string): Promise<GenerationOutcome> {
    for (const stage of JOB_STAGE_ORDER) {
      while (true) {
        // Cada passo da tarefa "authorized" começa provando a posse do claim (outro worker pode ter assumido).
        await assertExecutionFence();
        const job = await this.getJob(jobId);
        const authorization = job.jobAuthorization;
        if (!authorization || authorization.status !== 'active') return this.pauseAuthorizedJob(jobId, 'A autorização do job não está ativa.');
        const quote = await this.quoteStage(jobId, stage, true);
        if (quote.done) break;
        // AI UGC: referência pronta espera a decisão visual ("Esta será a pessoa…"). O teto continua valendo.
        if (quote.awaitingReview) return this.pauseAuthorizedJob(jobId, quote.blocked ?? "Aprove a referência UGC.", "ugc_reference");
        if (quote.blocked) return this.pauseAuthorizedJob(jobId, quote.blocked);
        const actual = await this.getJobCostReport(jobId);
        const spentSinceApproval = Math.max(0, actual.actual.totalBrl - authorization.baselineActualBrl);
        if (toCents(spentSinceApproval + quote.estimatedBrl) > toCents(authorization.estimatedBrl)) {
          return this.pauseAuthorizedJob(jobId, 'A cotação aumentou além do teto aprovado. Revise o novo custo antes de continuar.');
        }
        await this.withJobLock(jobId, async () => {
          await assertExecutionFence();
          const current = await this.getJob(jobId);
          const approval = current.jobAuthorization;
          if (!approval || approval.status !== 'active') throw new Error('Autorização do job expirada.');
          await this.deps.store.saveJob({
            ...current,
            stageApprovals: [...(current.stageApprovals ?? []), {
              stage, mode: quote.mode, provider: quote.provider, model: quote.model, unit: quote.unit,
              quoteToken: quote.token, estimatedBrl: quote.estimatedBrl, approvedAt: this.deps.clock(),
            }],
            waitingForStage: undefined,
            error: undefined,
          });
        });
        const outcome = await this.performHybridStage(jobId, stage);
        if (outcome.kind === "WAITING_STAGE" && outcome.job.stageIntents?.some(intent => intent.stage === stage && intent.state === "running")) {
          return this.pauseAuthorizedJob(jobId, "Operação aceita ou cobrança incerta. Retome explicitamente pelo operation ID; nenhum novo POST será feito.", stage);
        }
        if (outcome.kind !== 'WAITING_STAGE') {
          if (outcome.kind === 'COMPLETED') {
            const completed = await this.withJobLock(jobId, async () => {
              await assertExecutionFence();
              const current = await this.getJob(jobId);
              const next = { ...current, jobAuthorization: current.jobAuthorization ? { ...current.jobAuthorization, status: 'completed' as const, pausedReason: undefined } : undefined };
              await this.deps.store.saveJob(next);
              return next;
            });
            return { ...outcome, job: completed };
          }
          const reason = outcome.kind === 'FAILED' ? outcome.error
            : outcome.kind === 'AUDIO_REVIEW' ? 'A duração da narração precisa de revisão.'
            : 'O orçamento precisa de uma nova decisão.';
          const paused = await this.withJobLock(jobId, async () => {
            await assertExecutionFence();
            const current = await this.getJob(jobId);
            const next = { ...current, jobAuthorization: current.jobAuthorization ? { ...current.jobAuthorization, status: 'paused' as const, pausedReason: reason } : undefined };
            await this.deps.store.saveJob(next);
            return next;
          });
          return { ...outcome, job: paused };
        }
      }
    }
    return { kind: 'WAITING_STAGE', job: await this.getJob(jobId) };
  }
  async executeStage(jobId: string, stage: ExecutionStage, token: string, options: { regenerate?: boolean; authorizeOverBudget?: boolean; sceneId?: string; thenFreeRender?: boolean } = {}) {
    const { job, budgetStillBlocked } = await this.prepareStage(jobId, stage, token, options);
    if (budgetStillBlocked) return { job, completion: Promise.resolve({ kind: "WAITING_STAGE" as const, job }) };
    return { job, completion: (await this.dispatchJob(jobId, { kind: "hybrid_stage", stage, ...(options.regenerate ? { regenerate: true } : {}), ...(options.sceneId ? { sceneId: options.sceneId } : {}), ...(options.thenFreeRender ? { thenFreeRender: true } : {}) })).completion };
  }
  /** Regeneração voluntária de cena PRONTA (≠ recovery de falha). O servidor deriva o recipe da cena persistida. */
  async regenerateReadyScene(jobId: string, sceneId: string, token: string) {
    const ctx = await this.load(jobId);
    const scene = ctx.creative.scenes.find(item => item.id === sceneId && item.requiresGeneratedVideo);
    const attempts = ctx.job.scenes.find(item => item.sceneId === sceneId)?.attempts ?? [];
    if (!scene) throw new Error(`A cena ${sceneId} não pertence a este job.`);
    if (!activeAttempt(attempts) || attempts.at(-1)?.status !== "succeeded") throw new Error("A cena não está pronta; use a recuperação de cena com falha.");
    return this.executeStage(jobId, this.sceneStage(scene), token, { regenerate: true, sceneId, thenFreeRender: true });
  }
  /** Aprovação da etapa sob lock (sem executar). `inTask` = já dentro da tarefa do worker/processo. */
  private async prepareStage(jobId: string, stage: ExecutionStage, token: string, options: { regenerate?: boolean; authorizeOverBudget?: boolean; sceneId?: string } = {}, inTask = false) {
    if (stage === "planning") throw new Error("Use a ação de planejamento do projeto.");
    let budgetStillBlocked = false;
    const job = await this.withJobLock(jobId, async () => {
      // Dentro de uma tarefa (encadeamento grátis), aprovar de novo exige a posse do claim.
      await assertExecutionFence();
      if (!inTask) this.assertJobIdle(jobId);
      // Continuação dentro da própria tarefa: o job "ativo" é esta execução, não um bloqueio. Chamada externa segue barrada.
      const quote = await this.quoteStage(jobId, stage, inTask, options.regenerate, options.sceneId);
      if (token !== quote.token || (!quote.ready && !(options.authorizeOverBudget && quote.budgetDecision?.canAuthorizeOverBudget))) throw new Error(quote.blocked ?? "Estimativa alterada ou etapa concluída; revise novamente.");
      await this.adoptOfflineCampaign(await this.getCampaign((await this.getJob(jobId)).campaignId));
      let job = await this.getJob(jobId);
      if (!job.estimate) throw new Error("Job sem estimativa");
      if (quote.budgetDecision && options.authorizeOverBudget) job = { ...job, overBudgetAuthorization: authorizeOverBudget(quote.budgetDecision, (await this.getCampaign(job.campaignId)).request.budget, this.deps.clock(), job.overBudgetAuthorization) };
      const recheck = await this.checkJobBudget({ ...(await this.load(jobId)), job }, quote.estimatedBrl);
      if (recheck.kind === "BUDGET_EXCEEDED") { budgetStillBlocked = true; await this.deps.store.saveJob(job); return job; }
      if (job.status === "cost_estimated") job = transitionJob(job, "awaiting_approval", this.deps.clock());
      if (job.status === "failed") { job = transitionJob(job, "cost_estimated", this.deps.clock()); job = transitionJob(job, "awaiting_approval", this.deps.clock()); }
      job = { ...job, approval: { estimateId: job.estimate!.id, approvedTotalBrl: quote.estimatedBrl, overBudget: false, approvedAt: this.deps.clock() },
        stageApprovals: [...(job.stageApprovals ?? []), { stage, mode: quote.mode, provider: quote.provider, model: quote.model, unit: quote.unit, quoteToken: token, estimatedBrl: quote.estimatedBrl, approvedAt: this.deps.clock() }], waitingForStage: undefined, error: undefined };
      if (job.status === "awaiting_approval" || job.status === "completed" || job.status === "budget_exceeded") job = transitionJob(job, "generating", this.deps.clock());
      if (job.status !== "generating") throw new Error("Resolva a revisão/orçamento antes de executar outra etapa.");
      await this.deps.store.saveJob(job); return job;
    });
    return { job, budgetStillBlocked };
  }
  private async performHybridStage(jobId: string, stage: ExecutionStage, regenerate = false, targetSceneId?: string): Promise<GenerationOutcome> {
    this.hybridInvocations.add(jobId);
    try {
      if ((await this.getJob(jobId)).stageModes?.[stage] !== "real" && !this.mocksAllowed()) throw new Error(this.mockBlocked(stage));
      return await withRealStageAuthorization(stage, async () => {
        if (stage === "render") {
          await this.withJobLock(jobId, async () => { await assertExecutionFence(); const job = await this.getJob(jobId); await this.deps.store.saveJob(transitionJob(job, "rendering", this.deps.clock())); });
          return this.renderPhase(jobId);
        }
        return this.withJobLock(jobId, async () => {
          // Primeira operação sob o lock: um worker que perdeu o claim não lê para decidir nem grava nada da etapa.
          await assertExecutionFence();
          let ctx = await this.load(jobId); let job = ctx.job;
          assertCanStartPaidCall(job);
          const quote = await this.quoteStage(jobId, stage, true, regenerate, targetSceneId);
          if (quote.blocked || quote.done) throw new Error(quote.blocked ?? "Etapa já concluída");
          const paused = await this.pauseIfOverBudget(ctx, quote.estimatedBrl);
          if (paused) return paused;
          const mode = job.stageModes?.[stage] ?? "mock";
          if (mode === "real") {
            job = { ...job, stageIntents: [...(job.stageIntents ?? []).filter(i => i.stage !== stage || i.state !== "running"), { stage, unit: quote.unit, state: "running", createdAt: this.deps.clock() }] };
            await this.deps.store.saveJob(job); ctx = { ...ctx, job };
          }
          if (stage === "ugc_reference") {
            const provider = this.ugcReferenceProvider(ctx);
            job = await this.stage(job, "ugc_reference"); ctx = { ...ctx, job };
            const rate = (await this.deps.exchangeRates.getUsdBrl()).rate;
            // REAL: o custo é recalculado no fluxo antes do envio e não pode passar do aprovado nesta cotação.
            const result = await generateUgcReference(this.ugcDeps(), { campaign: ctx.campaign, plan: ctx.creative, job, provider, exchangeRate: rate, ...(mode === "real" ? { maxCostUsd: quote.estimatedBrl / rate } : {}) });
            job = result.job;
            if (result.reference.state === "failed") { job = { ...job, stageIntents: job.stageIntents?.map(i => i.stage === stage ? { ...i, state: "settled" as const } : i) }; return this.fail(job, result.reference.error ?? "Falha ao gerar a referência UGC"); }
          } else if (stage === "narration") {
            assertAttemptsAvailable(job.audioAttempts, this.deps.maxAttemptsPerScene);
            const provider = this.createAudioProvider(ctx); if (!provider.ok) return this.fail(job, provider.error);
            job = await this.stage(job, "narration");
            const result = await this.generateNarration({ ...ctx, job }, provider.provider); job = result.job;
            if (result.attempt.status === "failed") { job = { ...job, stageIntents: job.stageIntents?.map(i => i.stage === stage ? { ...i, state: "settled" as const } : i) }; return this.fail(job, result.attempt.error); }
          } else {
            for (const scene of ctx.creative.scenes.filter(s => s.requiresGeneratedVideo && this.sceneStage(s) === stage && (!targetSceneId || s.id === targetSceneId))) {
              const state = job.scenes.find(s => s.sceneId === scene.id)!;
              if (!regenerate && this.matchesMode(activeAttempt(state.attempts), mode)) continue;
              const pending = job.presenterTasks?.some(t => t.sceneId === scene.id && (t.state === "pending" || t.state === "submitting")) || job.videoTasks?.some(t => t.sceneId === scene.id && t.state === "pending") || job.ugcVideoOperations?.some(operation => operation.sceneId === scene.id && operation.state !== "settled");
              if (!pending) assertAttemptsAvailable(state.attempts, this.deps.maxAttemptsPerScene);
              job = await this.stage(job, this.sceneStage(scene)); ctx = { ...ctx, job };
              const result = stage === "avatar" ? await this.generatePresenterScene(ctx, scene, !pending && state.attempts.length > 0)
                : stage === "ugc_video" ? await this.runUgcScene(ctx, job, scene, mode, quote.estimatedBrl)
                : await this.generateSceneVideo(ctx, scene, this.videoProvider(ctx));
              job = result.job; if (result.attempt.status === "failed") { job = { ...job, stageIntents: job.stageIntents?.map(i => i.stage === stage ? { ...i, state: "settled" as const } : i) }; return this.fail(job, result.attempt.error); }
              if (mode === "real") break; // Uma cena paga por clique, nunca a próxima automaticamente.
            }
          }
          await assertExecutionFence();
          job = { ...job, stageIntents: job.stageIntents?.map(i => i.stage === stage ? { ...i, state: "settled" as const } : i) };
          if (stage === "narration" && activeAttempt(job.audioAttempts)?.narration?.fit?.action === "review") { const next = transitionJob(job, "audio_review", this.deps.clock()); await this.deps.store.saveJob(next); return { kind: "AUDIO_REVIEW", job: next }; }
          job = { ...job, renderStale: true, waitingForStage: stage, updatedAt: this.deps.clock() };
          await this.deps.store.saveJob(job);
          return { kind: "WAITING_STAGE", job };
        });
      });
    } catch (error) {
      if (error instanceof ExecutionLeaseLostError) throw error;
      // fail/pause/settle abaixo gravam o job: só com a posse do claim confirmada.
      await assertExecutionFence();
      const job = await this.getJob(jobId);
      if (error instanceof PresenterPendingError || error instanceof UgcPendingError) return { kind: "WAITING_STAGE", job };
      if (error instanceof UgcCostChangedError) {
        // Nada foi enviado: encerra a intenção da etapa e pausa pedindo nova aprovação.
        await this.withJobLock(jobId, async () => { const current = await this.getJob(jobId); await this.deps.store.saveJob({ ...current, stageIntents: current.stageIntents?.map(i => i.stage === stage ? { ...i, state: "settled" as const } : i) }); });
        return this.pauseAuthorizedJob(jobId, error.message);
      }
      return this.fail(job, messageOf(error));
    } finally { this.hybridInvocations.delete(jobId); }
  }
  private async runHybridMocks(jobId: string): Promise<GenerationOutcome> {
    for (const stage of JOB_STAGE_ORDER) {
      const job = await this.getJob(jobId);
      if (job.stageModes?.[stage] === "real" && !(await this.quoteStage(jobId, stage, true)).done) { const next = { ...job, waitingForStage: stage }; await this.deps.store.saveJob(next); return { kind: "WAITING_STAGE", job: next }; }
      const quote = await this.quoteStage(jobId, stage, true);
      if (quote.done) continue;
      // A execução ativa é nossa; bloqueios de dependência permanecem válidos.
      if (quote.blocked && quote.blocked !== "Etapa em andamento") { const next = { ...job, waitingForStage: stage }; await this.deps.store.saveJob(next); return { kind: "WAITING_STAGE", job: next }; }
      const result = await this.performHybridStage(jobId, stage);
      if (result.kind !== "WAITING_STAGE") return result;
    }
    return { kind: "WAITING_STAGE", job: await this.getJob(jobId) };
  }

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
    const parsed = CampaignRequestSchema.parse(input);
    const ugcMode = parsed.creativeMode === "ai_ugc";
    if (ugcMode && parsed.quality === "custom") throw new Error("AI UGC usa os presets Econômico, Equilibrado ou Premium.");
    if (ugcMode && parsed.product.images.length === 0) throw new Error("AI UGC precisa de ao menos uma foto real do produto para criar a referência pessoa + produto.");
    if (this.deps.hybrid && !this.mocksAllowed()) {
      // REAL-only: toda etapa com provider configurado vira REAL; etapa sem provider fica bloqueada na cotação.
      const caps = this.deps.hybrid.capabilities;
      parsed.stageModes = Object.fromEntries(EXECUTION_STAGES.map(stage => [stage, caps[stage].available ? "real" : parsed.stageModes?.[stage] ?? "mock"])) as StageModes;
      if (parsed.stageModes.planning !== "real") throw new Error(this.mockBlocked("planning"));
    }
    const planningMode = parsed.stageModes?.planning ?? "mock";
    if (!this.deps.hybrid) this.assertPlannerAvailable();
    if (this.deps.hybrid) for (const [stage, mode] of Object.entries(parsed.stageModes ?? {})) { if (mode === "real" && !this.deps.hybrid.capabilities[stage as ExecutionStage].available) throw new Error(this.deps.hybrid.capabilities[stage as ExecutionStage].reason); }
    const preset = parsed.quality !== "custom" && (parsed.simpleFlow || ugcMode)
      ? (ugcMode ? SIMPLE_UGC_QUALITY_PRESETS : SIMPLE_QUALITY_PRESETS)[parsed.quality]
      : resolveQualitySettings(parsed.quality, parsed.customSettings);
    const chosen = ugcMode && this.deps.ugcChoice && parsed.quality !== "custom" ? { ...preset, ugc: this.deps.ugcChoice(parsed.quality) } : preset;
    // Lote 6: duração escolhida (30/45/60s) redimensiona trechos/segundos do preset AI UGC.
    const resolved = ugcMode && parsed.targetDurationSeconds ? withTargetDuration(chosen, DURATION_TARGETS[parsed.targetDurationSeconds]) : chosen;
    // AI UGC: a estratégia de áudio é DECLARADA pelo UGCVideoProvider e fica fixa no projeto.
    // Lote 6: Voice Lock só com suporte REAL a áudio externo + lip-sync; "locked" sem suporte é recusado.
    const ugcVideo = ugcMode ? this.ugcFactories().video(this.deps.pricing.requireOne(resolved.ugc!.video), parsed.stageModes?.ugc_video ?? "mock") : undefined;
    // Correção Lote 6: avatar salvo COM foto exige provider de referência que aceite a foto. Sem
    // suporte, recusa ANTES de criar o projeto e de qualquer chamada paga (inclusive o roteiro).
    if (ugcMode && parsed.avatar?.snapshot?.referenceImage) this.assertAvatarIdentitySupported(resolved, parsed.stageModes?.ugc_reference);
    const request: CampaignRequest = ugcVideo
      ? {
          ...parsed, presenterPresetId: undefined, presenterChoice: undefined,
          ugc: {
            ...UgcRequestSchema.parse(parsed.ugc ?? {}), audioStrategy: ugcVideo.audioStrategy,
            voiceLockDecision: resolveVoiceLock({ requested: parsed.voiceLock ?? "auto", provider: ugcVideo.descriptor.id, capabilities: speechCapabilities(ugcVideo), ...(parsed.avatar?.snapshot?.voiceProfileId ? { voiceProfileId: parsed.avatar.snapshot.voiceProfileId } : {}) }),
          },
        }
      : parsed;
    const settings = this.deps.videoChoice && request.quality !== "custom" ? { ...resolved, video: this.deps.videoChoice } : resolved;
    await this.assertPlanningFitsBudget(request, settings, 0);

    const createdAt = clock();
    let campaign: Campaign = {
      id: ids("campaign"),
      status: "draft",
      executionMode: this.deps.hybrid ? "hybrid" : this.deps.offlineOnly ? "offline" : undefined,
      request,
      settings,
      plannerId: this.deps.hybrid ? (planningMode === "real" ? "anthropic" : "mock") : this.deps.planner.id,
      jobIds: [],
      createdAt,
      updatedAt: createdAt,
    };
    await store.saveCampaign(campaign);
    if (this.deps.hybrid && planningMode === "real") return { campaign, completion: Promise.resolve(campaign) };
    campaign = this.beginPlanningRun(campaign);
    await store.saveCampaign(campaign);
    return { campaign, completion: (await this.dispatchPlanning(campaign, false)).completion };
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
      if (campaign.executionMode === "hybrid" && campaign.request.stageModes?.planning === "real") throw new Error("Use a aprovação explícita da etapa de planejamento.");
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
      return { campaign, completion: (await this.dispatchPlanning(campaign, false)).completion };
    });
  }

  /** false = o planner configurado não pode ser usado (ex.: sem ANTHROPIC_API_KEY). */
  planningAvailable(): boolean {
    return this.deps.planner.unavailable === undefined;
  }

  /** true se ESTE processo está executando o planejamento da campanha. */
  isPlanningActive(campaignId: string): boolean {
    return this.activePlanning.has(campaignId) || this.deps.activity?.isActive(planningKey(campaignId)) === true;
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

  /** Edita o storyboard antes da geração e invalida somente estimativa/aprovação derivadas. */
  async updateStoryboardScene(jobId: string, input: { sceneId: string; narration: string; visualDescription: string; visualSource: VisualSource }): Promise<GenerationJob> {
    return this.withJobLock(jobId, async () => {
      this.assertJobIdle(jobId);
      const ctx = await this.load(jobId);
      if (!['planned', 'cost_estimated', 'awaiting_approval'].includes(ctx.job.status)) throw new Error('Edite o roteiro em uma nova versão depois que a geração começar.');
      if (ctx.job.audioAttempts.length > 0 || ctx.job.scenes.some(scene => scene.attempts.length > 0)) throw new Error('Este job já possui mídia. Crie outra versão para editar o storyboard sem invalidar assets.');
      const generated = isGeneratedSource(input.visualSource);
      if (input.visualSource === 'product_ugc') throw new Error('Product UGC ainda está preparado apenas na arquitetura e não pode ser selecionado neste lote.');
      const ugcMode = ctx.campaign.request.creativeMode === 'ai_ugc';
      const ugcSource = isUgcPersonSource(input.visualSource) || input.visualSource === 'product_broll';
      if (!ugcMode && ugcSource) throw new Error('Cenas AI UGC só existem em projetos AI UGC.');
      if (ugcMode && !ugcSource && !['product_image', 'text_card', 'reference_detail'].includes(input.visualSource)) throw new Error('No AI UGC use cenas UGC, B-roll, imagem do produto ou texto.');
      if (ugcMode) {
        const speech = input.narration.trim();
        if (this.nativeUgcSpeech(ctx.job) && !isUgcPersonSource(input.visualSource) && speech) throw new Error('Com fala nativa do vídeo, só as cenas UGC têm fala; deixe a fala desta cena vazia.');
        if (isUgcPersonSource(input.visualSource) && !speech) throw new Error('Cena UGC precisa de uma fala para a câmera.');
        const violations = findUgcSpeechViolations(speech);
        if (violations.length) throw new Error(`Fala não permitida: ${violations.join('; ')}.`);
      }
      if (input.visualSource === 'presenter' && !ctx.campaign.request.presenterPresetId) throw new Error('Escolha um apresentador antes de transformar a cena em apresentação.');
      const scene = ctx.creative.scenes.find(item => item.id === input.sceneId);
      if (!scene) throw new Error('Cena não encontrada.');
      if (ctx.creative.editPlanVersion === 3 && !isUgcPersonSource(input.visualSource)) throw new Error('Presenter Only: todo trecho é a apresentadora falando (sem B-roll, foto ou card).');
      if (ctx.creative.editPlanVersion === 2) {
        // Editor V2: o papel editorial não muda na edição (A-roll = fala; B-roll = detalhe sem fala).
        if ((scene.edit?.role === 'aroll') !== isUgcPersonSource(input.visualSource)) throw new Error('No Editor V2 o A-roll continua A-roll (pessoa falando) e o B-roll continua B-roll (detalhe por cima do áudio).');
        if (['product_image', 'text_card'].includes(input.visualSource) && ctx.campaign.request.ugc?.commercialStyle !== true) throw new Error('B-roll de catálogo (foto em fundo branco/card) não é usado no UGC; escolha detalhe da referência ou B-roll gerado.');
      }
      if (ugcMode && !speechFitsDuration(input.narration, scene.duration)) throw new Error(`Fala longa demais para ${scene.duration}s de cena.`);
      const nextScene = ScenePlanSchema.parse({
        ...scene,
        narration: input.narration.trim(),
        visualDescription: input.visualDescription.trim(),
        visualSource: input.visualSource,
        requiresGeneratedVideo: generated,
        estimatedGenerationSeconds: generated ? (isUgcPersonSource(input.visualSource) ? scene.duration : Math.min(scene.duration, Math.max(2, scene.estimatedGenerationSeconds || scene.duration))) : 0,
        generationPrompt: generated ? (scene.generationPrompt.trim() || `Natural product video. ${input.visualDescription.trim()}`) : '',
        motion: input.visualSource === 'presenter' || isUgcPersonSource(input.visualSource) || input.visualSource === 'reference_detail' ? 'none' : generated ? scene.motion : scene.motion === 'none' ? 'ken_burns' : scene.motion,
        ...(scene.edit?.role === 'broll' ? { edit: { ...scene.edit, brollKind: input.visualSource === 'product_broll' ? 'generated_context' : input.visualSource === 'product_image' ? 'product_photo' : 'reference_detail' } } : {}),
      });
      const updatedCreative = {
        ...ctx.creative,
        scenes: ctx.creative.scenes.map(item => item.id === scene.id ? nextScene : item),
        script: ctx.creative.scenes.map(item => item.id === scene.id ? nextScene.narration : item.narration).filter(Boolean).join(' '),
      };
      const rate = (await this.deps.exchangeRates.getUsdBrl()).rate;
      const reviewed = reviewCampaignPlan({
        ...ctx.campaign.plan!,
        creatives: ctx.campaign.plan!.creatives.map(item => item.id === updatedCreative.id ? updatedCreative : item),
      }, ctx.campaign.settings, ctx.pricing, rate);
      const campaign = { ...ctx.campaign, plan: reviewed.plan, reviews: reviewed.reviews, updatedAt: this.deps.clock() };
      let job: GenerationJob = {
        ...ctx.job,
        scenes: reviewed.plan.creatives.find(item => item.id === ctx.creative.id)!.scenes.map(item => ({
          sceneId: item.id,
          order: item.order,
          requiresGeneratedVideo: item.requiresGeneratedVideo,
          attempts: ctx.job.scenes.find(state => state.sceneId === item.id)?.attempts ?? [],
        })),
        storyboardRevision: (ctx.job.storyboardRevision ?? 0) + 1,
        jobAuthorization: undefined,
        stageApprovals: [],
      };
      if (job.status === 'awaiting_approval') job = transitionJob(job, 'cost_estimated', this.deps.clock());
      await this.deps.store.saveCampaign(campaign);
      await this.deps.store.saveJob(job);
      return this.estimateJob(job.id);
    });
  }

  // ---------------------------------------------------------------- AI UGC: referência

  /**
   * "Esta será a pessoa apresentando seu produto": aprova a referência mais recente da identidade
   * atual. Se o job estava pausado nessa decisão, continua sob a MESMA autorização (teto e ledger).
   */
  async approveUgcReference(jobId: string, referenceId: string, review: UgcFidelityReview = { fidelityConfirmed: false }): Promise<{ job: GenerationJob; resumed: boolean; completion?: Promise<GenerationOutcome> }> {
    let fidelityError: string | undefined;
    const job = await this.withJobLock(jobId, async () => {
      this.assertJobIdle(jobId);
      const current = await this.getJob(jobId);
      const state = current.ugc;
      if (!state) throw new Error("Este job não é AI UGC.");
      const reference = state.references.find(r => r.id === referenceId);
      if (!reference || reference.state !== "succeeded") throw new Error("Referência não encontrada ou não concluída.");
      if (reference.identityId !== state.identity.id || reference.identityRevision !== state.identity.revision) throw new Error("A referência é de um apresentador/ambiente anterior; gere outra.");
      if (latestReference(state)?.id !== reference.id) throw new Error("Aprove a referência mais recente.");
      if (reference.isMock && !this.mocksAllowed()) throw new Error("Referência simulada (MOCK) não pode ser aprovada: não existe imagem real da pessoa. Gere uma referência real.");
      // Product Fidelity Gate: aprovar exige revisão humana explícita de produto/logo/textos/números.
      if (!review.fidelityConfirmed) throw new UgcFidelityError("Verifique se produto, logo, textos e especificações continuam fiéis e confirme antes de aprovar.");
      const now = this.deps.clock();
      const fidelity = decideFidelity(reference.fidelity ?? initialFidelity(state.product.fidelityConstraints ?? []), { confirmed: true, observedTexts: review.observedTexts, confirmedSpecs: review.confirmedSpecs, note: review.note, reviewedAt: now });
      if (fidelity.status === "pending") {
        // Especificação conhecida (ex.: 2100W) sem conferência explícita: nada é gravado como aprovado.
        const missing = missingSpecConfirmations(fidelity.constraints, fidelity.confirmedSpecs);
        throw new UgcFidelityError(`Confira na imagem cada especificação do produto antes de aprovar: ${missing.join(", ")}.`);
      }
      if (fidelity.status !== "approved") {
        // Conflito conhecido (ex.: esperado 2100W, observado 3900): registra e NÃO segue automaticamente.
        const blocked: GenerationJob = { ...current, ugc: { ...state, references: state.references.map(r => r.id === reference.id ? { ...r, fidelity } : r) }, updatedAt: now };
        await this.deps.store.saveJob(blocked);
        fidelityError = `Fidelidade em revisão: ${fidelity.conflicts.map(c => `esperado ${c.expected}, observado ${c.observed}`).join("; ")}. Gere outra referência.`;
        return blocked;
      }
      const next: GenerationJob = {
        ...current,
        ugc: { ...state, references: state.references.map(r => r.id === reference.id ? { ...r, review: "approved" as const, fidelity, reviewedAt: now } : r.review === "approved" ? { ...r, review: "rejected" as const, reviewedAt: now } : r) },
        updatedAt: now,
      };
      await this.deps.store.saveJob(next);
      return next;
    });
    if (fidelityError) throw new UgcFidelityError(fidelityError);
    return this.resumeAfterUgcDecision(job);
  }

  /** "Gerar outra referência": rejeita a atual; a próxima é gerada dentro do teto (nova versão, novo custo). */
  async regenerateUgcReference(jobId: string, fidelityRejection?: { observedTexts?: string[]; note?: string }): Promise<{ job: GenerationJob; resumed: boolean; completion?: Promise<GenerationOutcome> }> {
    const job = await this.withJobLock(jobId, async () => {
      this.assertJobIdle(jobId);
      const current = await this.getJob(jobId);
      if (!current.ugc) throw new Error("Este job não é AI UGC.");
      this.assertNoUgcScenes(current);
      const attempts = current.ugc.references.filter(reference => reference.identityId === current.ugc?.identity.id && reference.identityRevision === current.ugc?.identity.revision).length;
      if (attempts >= this.deps.maxAttemptsPerScene) throw new Error("Limite de tentativas da referência UGC atingido.");
      let ugc = current.ugc;
      const latest = latestReference(ugc);
      if (fidelityRejection && latest?.state === "succeeded") {
        // Reprovação por fidelidade fica registrada na versão rejeitada (auditoria do problema).
        const fidelity = decideFidelity(latest.fidelity ?? initialFidelity(ugc.product.fidelityConstraints ?? []), { confirmed: false, ...fidelityRejection, reviewedAt: this.deps.clock() });
        ugc = { ...ugc, references: ugc.references.map(r => r.id === latest.id ? { ...r, fidelity } : r) };
      }
      const next = { ...current, ugc: this.rejectOpenReferences(ugc), updatedAt: this.deps.clock() };
      await this.deps.store.saveJob(next);
      return next;
    });
    return this.resumeAfterUgcDecision(job);
  }

  /** "Trocar apresentador" / "Trocar ambiente": nova revisão da identidade; exige nova referência. */
  async updateUgcIdentity(jobId: string, change: { presenter?: UgcPresenterChoice; environment?: UgcEnvironmentChoice }): Promise<{ job: GenerationJob; resumed: boolean; completion?: Promise<GenerationOutcome> }> {
    const job = await this.withJobLock(jobId, async () => {
      this.assertJobIdle(jobId);
      const ctx = await this.load(jobId);
      const state = ctx.job.ugc;
      if (!state) throw new Error("Este job não é AI UGC.");
      this.assertNoUgcScenes(ctx.job);
      const base = UgcRequestSchema.parse(ctx.campaign.request.ugc ?? {});
      const identity: UgcCharacterIdentity = resolveUgcIdentity({
        id: state.identity.id,
        revision: state.identity.revision + 1,
        product: ctx.campaign.request.product,
        request: {
          ...base,
          presenter: change.presenter ?? state.identity.gender,
          environment: change.environment ?? state.identity.environment,
          visualStyle: state.identity.visualStyle,
        },
        // Lote 6: trocar só o ambiente mantém o avatar da biblioteca; trocar o apresentador sai dele.
        ...(state.identity.source === "library" && !change.presenter && ctx.campaign.request.avatar?.snapshot
          ? { avatar: ctx.campaign.request.avatar.snapshot, ...(state.identity.voiceDescription ? { voiceDescription: state.identity.voiceDescription } : {}) } : {}),
      });
      const next: GenerationJob = { ...ctx.job, ugc: { ...this.rejectOpenReferences(state), identity }, updatedAt: this.deps.clock() };
      await this.deps.store.saveJob(next);
      return next;
    });
    return this.resumeAfterUgcDecision(job);
  }

  private assertNoUgcScenes(job: GenerationJob): void {
    if (job.scenes.some(s => s.attempts.some(a => a.ugc))) throw new Error("Já existem cenas UGC geradas com esta referência. Crie uma cópia do projeto para trocar a pessoa sem perder a consistência.");
  }

  private rejectOpenReferences(state: NonNullable<GenerationJob["ugc"]>): NonNullable<GenerationJob["ugc"]> {
    const now = this.deps.clock();
    return { ...state, references: state.references.map(r => r.review !== "rejected" && r.state === "succeeded" ? { ...r, review: "rejected" as const, reviewedAt: now } : r) };
  }

  /** Se o job estava pausado na revisão visual, retoma a sequência com a autorização existente. */
  private async resumeAfterUgcDecision(job: GenerationJob): Promise<{ job: GenerationJob; resumed: boolean; completion?: Promise<GenerationOutcome> }> {
    if (job.jobAuthorization?.status !== "paused" || job.waitingForStage !== "ugc_reference") return { job, resumed: false };
    const resumed = await this.withJobLock(job.id, async () => {
      const current = await this.getJob(job.id);
      const next: GenerationJob = { ...current, jobAuthorization: current.jobAuthorization ? { ...current.jobAuthorization, status: "active", pausedReason: undefined } : undefined, waitingForStage: undefined, error: undefined, updatedAt: this.deps.clock() };
      await this.deps.store.saveJob(next);
      return next;
    });
    return { job: resumed, resumed: true, completion: (await this.dispatchJob(job.id, { kind: "authorized" })).completion };
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
      await assertExecutionFence();
      outcome = { ok: true, result: await (this.deps.hybrid ? this.deps.hybrid.planner(started.request.stageModes?.planning ?? "mock") : this.deps.planner).plan(this.toPlanningRequest(started.request, settings)) };
    } catch (error) {
      if (error instanceof ExecutionLeaseLostError) throw error;
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
      // Editor V2 (Lote 5.6): AI UGC vira narrativa contínua — A-roll como espinha de áudio e
      // B-roll overlay — antes de revisar custo. Determinístico, sem nova chamada paga.
      // external_lipsync (narração contínua ElevenLabs) continua na montagem linear; V2 = fala nativa.
      // Lote 5.7: padrão = Presenter Only (só a apresentadora); B-roll (V2) só com brollEnabled.
      const presenterOnly = started.request.ugc?.brollEnabled !== true;
      // Lote 6: roteiro mestre único → segmentos de fala (um por A-roll), mesma persona em todos.
      const duration = started.request.creativeMode === "ai_ugc" && presenterOnly ? started.request.targetDurationSeconds : undefined;
      let scriptedPlan = selectedPlan;
      if (duration) {
        try {
          const persona = personaFor(started.request.avatar?.snapshot, started.request.personalization);
          scriptedPlan = { ...selectedPlan, creatives: selectedPlan.creatives.map((creative) => applyMasterScript(creative, { duration, persona })) };
        } catch (error) {
          campaign = { ...transitionCampaign(campaign, "failed", clock()), error: `Roteiro mestre inválido: ${messageOf(error)}`, errorCode: "invalid_response" };
          await store.saveCampaign(campaign);
          return campaign;
        }
      }
      const editorialPlan = started.request.creativeMode === "ai_ugc" && started.request.ugc?.audioStrategy !== "external_lipsync" ? {
        ...scriptedPlan, creatives: scriptedPlan.creatives.map(creative => presenterOnly ? applyPresenterOnly(creative, { minFinalSeconds: settings.finalVideoSeconds.min }).plan : applyUgcEditorial(creative, {
          commercialStyle: started.request.ugc?.commercialStyle === true,
          finalRange: settings.finalVideoSeconds,
          ...(settings.quality === "custom" ? {} : { quality: settings.quality }),
        }).plan),
      } : scriptedPlan;
      const review = reviewCampaignPlan(editorialPlan, settings, pricing, rate);
      const ugcState = started.request.creativeMode === "ai_ugc" ? () => initialUgcState(started, this.deps.ids, started.request.ugc?.audioStrategy ?? "native_speech") : undefined;
      const jobs = review.plan.creatives.map((creative) => ({ ...this.newJob(campaign.id, creative), ...(this.deps.hybrid ? { stageModes: started.request.stageModes ?? { ...MOCK_STAGE_MODES } } : {}), ...(ugcState ? { ugc: ugcState() } : {}),
        ...(started.request.avatar?.avatarId && started.request.avatar.avatarRevision ? { avatar: {
          avatarId: started.request.avatar.avatarId, avatarRevision: started.request.avatar.avatarRevision,
          identityStrategy: started.request.avatar.snapshot?.referenceImage ? "avatar_reference_image" as const : "avatar_description" as const,
          ...(started.request.avatar.snapshot?.referenceImage ? { avatarReferenceAsset: { ...started.request.avatar.snapshot.referenceImage } } : {}),
        } } : {}),
        ...(started.request.ugc?.voiceLockDecision ? { voiceLock: started.request.ugc.voiceLockDecision } : {}) }));
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
      creativeMode: request.creativeMode, ugcAudioStrategy: request.ugc?.audioStrategy,
      ...(request.creativeMode === "ai_ugc" ? { ugcPresenterOnly: request.ugc?.brollEnabled !== true } : {}),
      ...(request.targetDurationSeconds ? { targetDurationSeconds: request.targetDurationSeconds } : {}),
      ...(request.avatar?.snapshot ? { presenterPersona: { name: request.avatar.snapshot.name, personality: request.avatar.snapshot.personality, speakingStyle: request.avatar.snapshot.speakingStyle, gender: request.avatar.snapshot.gender } } : {}),
      ...(request.personalization ? { personalization: request.personalization } : {}),
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
      nativeUgcSpeech: this.nativeUgcSpeech(job),
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
      if (this.deps.hybrid) await this.adoptOfflineCampaign(ctx.campaign);
      assertApprovalValid(ctx.job);
      const next = transitionJob(ctx.job, "generating", this.deps.clock());
      await this.deps.store.saveJob(next);
      return next;
    });
    return { job, completion: (await this.dispatchJob(jobId, this.deps.hybrid ? { kind: "hybrid_mocks" } : { kind: "continue" })).completion };
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
    return { job, completion: (await this.dispatchJob(jobId, this.deps.hybrid ? { kind: "hybrid_mocks" } : { kind: "continue" })).completion };
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
    if (this.deps.hybrid) {
      const job = await this.getJob(jobId);
      if (!job.stageModes) throw new Error("Crie uma cópia híbrida para continuar.");
      if (job.status !== "generating") throw new Error("Use a execução ou nova versão no painel de etapas.");
      this.assertJobIdle(jobId);
      return { job, completion: (await this.dispatchJob(jobId, { kind: "hybrid_mocks" })).completion };
    }
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
    const run: JobRun = this.deps.hybrid ? { kind: "hybrid_mocks" } : resumeGeneration ? { kind: "continue" } : { kind: "render" };
    return { job, completion: (await this.dispatchJob(jobId, run)).completion };
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
        ...transitionJob(ctx.job, this.deps.hybrid || ctx.creative.scenes.some(s => s.visualSource === "presenter") ? "generating" : "rendering", acceptedAt),
        audioAttempts: ctx.job.audioAttempts.map((a) =>
          a.id === active.id && a.narration ? { ...a, narration: { ...a.narration, reviewAcceptedAt: acceptedAt } } : a,
        ),
        error: undefined,
      };
      await this.deps.store.saveJob(next);
      return next;
    });
    return { job, completion: (await this.dispatchJob(jobId, this.deps.hybrid ? { kind: "hybrid_mocks" } : job.status === "generating" ? { kind: "continue" } : { kind: "render" })).completion };
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
      if (ctx.campaign.executionMode === "hybrid") throw new Error("Use a execução explícita no painel de etapas.");
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
    const completion = (await this.dispatchJob(jobId, { kind: "narration_regen", previousStatus: prepared.previousStatus })).completion;
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
    return this.activeJobs.has(jobId) || this.deps.activity?.isActive(jobKey(jobId)) === true;
  }

  /**
   * L8.6 (só leitura): "running" = executando (neste processo ou assumido por um worker);
   * "queued" = na fila durável, ainda não assumido; undefined = sem execução ativa.
   */
  executionState(key: { jobId: string } | { campaignId: string }): "queued" | "running" | undefined {
    const queueKey = "jobId" in key ? jobKey(key.jobId) : planningKey(key.campaignId);
    // Execução neste processo (local/worker) = rodando de fato.
    if ("jobId" in key ? this.activeJobs.has(key.jobId) : this.activePlanning.has(key.campaignId)) return "running";
    if (!this.deps.activity?.isActive(queueKey)) return undefined;
    return this.deps.activity.state?.(queueKey) ?? "running";
  }

  /** L8.8.1: fatos leves direto do store quando ele sabe (cloud/SQL); null = extrair dos documentos. */
  async listProjectFactsFast(): Promise<ProjectFacts[] | null> {
    return this.deps.store.listProjectFacts ? this.deps.store.listProjectFacts() : null;
  }

  /** Job em "generating"/"rendering" sem execução neste processo = interrompido (derivado). */
  isJobInterrupted(job: GenerationJob): boolean {
    return (job.status === "generating" || job.status === "rendering") && !job.waitingForStage && !this.isJobActive(job.id);
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
    // Fluxo legado síncrono (chamada paga dentro do request): indisponível no cloud.
    if (this.deps.dispatcher) throw new UnexpectedStatusError("Use a regeneração do painel de etapas (com aprovação da etapa).");
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
        const preview = await presenterPreview(this.deps, ctx.campaign, ctx.creative, job, scene, this.presenterProvider(ctx).descriptor.isMock);
        additional = this.presenterProvider(ctx).estimateCost(preview.durationSeconds).costUsd * (await this.deps.exchangeRates.getUsdBrl()).rate;
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
          video = this.videoProvider(ctx);
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
    const hybrid = (await this.getCampaign(job.campaignId)).executionMode === "hybrid";
    return { estimate: job.estimate, actual: summarizeActualCosts(hybrid ? entries.filter(e => !e.simulated) : entries, discardedAttemptIds(job)) };
  }

  async getCampaignCostReport(campaignId: string): Promise<ActualCostSummary> {
    const jobs = await this.deps.store.listJobs(campaignId);
    const discarded = new Set(jobs.flatMap((j) => [...discardedAttemptIds(j)]));
    const entries = await this.deps.ledger.list({ campaignId });
    return summarizeActualCosts((await this.getCampaign(campaignId)).executionMode === "hybrid" ? entries.filter(e => !e.simulated) : entries, discarded);
  }

  /** L8.2: leitura do ledger (somente leitura; créditos são derivados dele, nunca gravados). */
  listCostEntries(): Promise<readonly GenerationCost[]> {
    return this.deps.ledger.list();
  }

  // ---------------------------------------------------------------- internos

  /** Geração (sob o lock da campanha: chamadas pagas + orçamento) e depois render (fora do lock). */
  private async continueGeneration(jobId: string): Promise<GenerationOutcome> {
    if (this.deps.hybrid) throw new Error("Use a nova versão no painel de etapas, com custo e aprovação próprios.");
    const outcome = await this.withJobLock(jobId, async () => this.runGeneration(await this.load(jobId)));
    if (outcome.kind !== "READY_TO_RENDER") return outcome;
    return this.renderPhase(jobId);
  }

  private async runGeneration(ctx: JobContext): Promise<GenerationOutcome | { kind: "READY_TO_RENDER" }> {
    let job = ctx.job;
    if (ctx.creative.scenes.some(s => isUgcPersonSource(s.visualSource))) return this.fail(job, "AI UGC usa o fluxo atual com autorização única: gere pelo projeto na interface.");
    const hasPresenter = ctx.creative.scenes.some(s => s.visualSource === "presenter");
    let video: VideoProvider | undefined;
    try {
      if (hasPresenter) {
        if (!ctx.campaign.request.presenterPresetId) throw new Error("Selecione um avatar para o presenter antes de aprovar.");
        this.presenterProvider(ctx);
      }
      const genericScenes = ctx.creative.scenes.filter(s => s.requiresGeneratedVideo && s.visualSource !== "presenter");
      if (genericScenes.length) video = this.videoProvider(ctx);
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
          const preview = await presenterPreview(this.deps, ctx.campaign, ctx.creative, job, scene, this.presenterProvider(ctx).descriptor.isMock);
          const rate = (await this.deps.exchangeRates.getUsdBrl()).rate;
          additional = Math.max(0, additional - sceneEstimateBrl(job, scene.id)) + this.presenterProvider(ctx).estimateCost(preview.durationSeconds).costUsd * rate;
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
      return { ok: true, provider: this.deps.hybrid ? this.deps.hybrid.audio(ctx.pricing.audio, ctx.job.stageModes?.narration ?? "mock") : this.deps.audioProviderFactory(ctx.pricing.audio) };
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

  private presenterProvider(ctx?: JobContext): PresenterProvider {
    if (this.deps.hybrid && ctx) return this.deps.hybrid.presenter(this.deps.pricing.requireOne(RUNWAY_PRESENTER), ctx.job.stageModes?.avatar ?? "mock");
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
    this.assertHybridInvocation(ctx.job, "avatar");
    const provider = this.presenterProvider(ctx);
    return generatePresenter(this.presenterDeps(), { campaign: ctx.campaign, plan: ctx.creative, job: ctx.job, scene, provider,
      exchangeRate: (await this.deps.exchangeRates.getUsdBrl()).rate, regenerate });
  }
  private videoRequest(ctx: JobContext, scene: ScenePlan) {
    return { sceneId: scene.id, visualSource: scene.visualSource, prompt: scenePromptFor(scene, scene.visualSource as GeneratedVisualSource), durationSeconds: scene.estimatedGenerationSeconds,
      aspectRatio: "9:16" as const, referenceImageUris: this.brollReferenceUris(ctx, scene) };
  }

  /**
   * Imagens de entrada do vídeo genérico. O provider genérico (Runway) só lê UPLOADS_DIR; por isso
   * o B-roll gerado ainda parte da foto do produto, com prompt contextual (mão, mesmo ambiente).
   * Os presets do Editor V2 preferem `reference_detail` (frame aprovado, custo zero).
   */
  private brollReferenceUris(ctx: JobContext, _scene: ScenePlan): string[] {
    return ctx.campaign.request.product.images.map((i) => i.uri);
  }

  private async generateSceneVideo(
    ctx: JobContext,
    scene: ScenePlan,
    provider: VideoProvider,
  ): Promise<{ job: GenerationJob; attempt: MediaAttempt }> {
    this.assertHybridInvocation(ctx.job, "scenes");
    assertCanStartPaidCall(ctx.job);
    return this.executeAttempt(ctx, {
      kind: "video",
      sceneId: scene.id,
      provider: provider.descriptor,
      category: scene.visualSource === "product_broll" ? "broll" : "video",
      operation: "video_generation",
      description: scene.visualSource === "product_broll" ? `B-roll do produto — cena ${scene.order + 1}` : `Vídeo IA — cena ${scene.order + 1}`,
      run: async (attemptId) => {
        const durable = ctx.campaign.executionMode === "hybrid" && !provider.descriptor.isMock;
        const previous = durable ? ctx.job.videoTasks?.findLast(t => t.sceneId === scene.id && (t.state === "pending" || t.state === "submitting")) : undefined;
        if (previous) {
          if (!previous.providerJobId || !provider.resumeTask) throw new Error("Envio de vídeo incerto. Sem reenvio pago automático.");
          const ref = { providerJobId: previous.providerJobId };
          provider.resumeTask(ref, this.videoRequest(ctx, scene));
          try { return await this.awaitResult(ref, provider); }
          catch (error) { if (error instanceof ProviderError && error.billedUsage) ctx.job = { ...ctx.job, videoTasks: ctx.job.videoTasks?.map(t => t.providerJobId === ref.providerJobId ? { ...t, state: "settled" as const } : t) }; throw error; }
        }
        if (durable) {
          await assertExecutionFence();
          ctx.job = { ...ctx.job, videoTasks: [...(ctx.job.videoTasks ?? []), { attemptId, sceneId: scene.id, providerJobId: "", provider: provider.descriptor.id, model: provider.descriptor.model, createdAt: this.deps.clock(), state: "submitting" }] };
          await this.deps.store.saveJob(ctx.job);
        }
        await assertExecutionFence();
        const ref = await provider.generateScene(this.videoRequest(ctx, scene));
        const task = { attemptId, sceneId: scene.id, providerJobId: ref.providerJobId, provider: provider.descriptor.id, model: provider.descriptor.model, createdAt: this.deps.clock(), ...(durable ? { state: "pending" as const } : {}) };
        ctx.job = { ...ctx.job, videoTasks: [...(ctx.job.videoTasks ?? []).filter(t => !(durable && t.sceneId === scene.id && t.state === "submitting")), task] };
        await this.deps.store.saveJob(ctx.job);
        try { return await this.awaitResult(ref, provider); }
        catch (error) {
          if (error instanceof ProviderError && error.billedUsage) {
            ctx.job = { ...ctx.job, videoTasks: ctx.job.videoTasks?.map(t => t.providerJobId === ref.providerJobId ? { ...t, state: "settled" as const } : t) };
          }
          throw error;
        }
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
        return { uri: stored.uri, durationSeconds: media.actualMediaDurationSeconds ?? requested, media, audioSilence: stored.audioSilence };
      },
    });
  }

  private async generateNarration(
    ctx: JobContext,
    provider: AudioProvider,
  ): Promise<{ job: GenerationJob; attempt: MediaAttempt }> {
    this.assertHybridInvocation(ctx.job, "narration");
    assertCanStartPaidCall(ctx.job);
    // Narração CONTÍNUA por criativo (D55): um texto falado, uma chamada, um timing.
    const speaker = getSpeakerProfile(ctx.campaign.request.speakerProfileId);
    const script = buildNarrationScript(ctx.creative);
    const outcome = await this.executeAttempt(ctx, {
      kind: "audio",
      sceneId: null,
      provider: provider.descriptor,
      category: "audio",
      operation: "audio_generation",
      description: `Narração (TTS · ${speaker.name})`,
      run: async () => {
        await assertExecutionFence();
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
    return this.recordMasterAudio(ctx, outcome, provider);
  }

  /**
   * Lote 6 — Voice Lock: a narração contínua vira o ÁUDIO MESTRE do vídeo inteiro; cada trecho usa
   * o intervalo do seu segmento do roteiro mestre (divisão lógica, sem novo áudio por trecho).
   */
  private async recordMasterAudio(ctx: JobContext, outcome: { job: GenerationJob; attempt: MediaAttempt }, provider: AudioProvider): Promise<{ job: GenerationJob; attempt: MediaAttempt }> {
    const { attempt } = outcome;
    const master = ctx.creative.masterScript;
    if (outcome.job.voiceLock?.strategy !== "locked_voice" || !master || attempt.status !== "succeeded" || !attempt.assetUri || !attempt.durationSeconds) return outcome;
    const segments = masterAudioSegments({ durationSeconds: attempt.durationSeconds, segmentWordCounts: master.segments.map((s) => s.wordCount), sceneIds: master.segments.map((s, i) => s.sceneId ?? `segment_${i + 1}`) });
    const job: GenerationJob = {
      ...outcome.job,
      masterAudio: {
        narrationVersion: attempt.narration?.version ?? attempt.id, uri: attempt.assetUri, durationSeconds: attempt.durationSeconds,
        provider: provider.descriptor.id, model: provider.descriptor.model, ...(outcome.job.voiceLock.voiceProfileId ? { voiceProfileId: outcome.job.voiceLock.voiceProfileId } : {}), segments,
      },
      updatedAt: this.deps.clock(),
    };
    await this.deps.store.saveJob(job);
    return { job, attempt };
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
    if (!result.data) return { uri: result.uri, durationSeconds: result.durationSeconds, narration: result.isMock && ["offline", "hybrid"].includes(ctx.campaign.executionMode ?? "") ? { ...narration, version: `mock-v${ctx.job.audioAttempts.length + 1}` } : narration };

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
      run: (attemptId: string) => Promise<{ ref: ProviderJobRef; result: MediaResult }>;
      /** Pós-processamento DEPOIS do custo registrado (ex.: salvar a narração). Falha = tentativa falha (custo mantido). */
      finalize?: (result: MediaResult, attemptId: string, ref: ProviderJobRef) => Promise<{ uri: string; durationSeconds: number; narration?: NarrationInfo; media?: ClipDurationCheck; audioSilence?: MediaAttempt["audioSilence"] }>;
    },
  ): Promise<{ job: GenerationJob; attempt: MediaAttempt }> {
    const { clock, ids } = this.deps;
    const previous = spec.kind === "audio"
      ? ctx.job.audioAttempts
      : (ctx.job.scenes.find((s) => s.sceneId === spec.sceneId)?.attempts ?? []);
    const pendingVideoTask = ctx.campaign.executionMode === "hybrid" && spec.kind === "video" ? ctx.job.videoTasks?.findLast(t => t.sceneId === spec.sceneId && t.state === "pending") : undefined;
    const attemptId = pendingVideoTask?.attemptId ?? ids("attempt");
    const base = {
      id: attemptId,
      kind: spec.kind,
      sceneId: spec.sceneId,
      attemptNumber: previous.find(a => a.id === attemptId)?.attemptNumber ?? previous.length + 1,
      provider: spec.provider.id,
      model: spec.provider.model,
      isMock: spec.provider.isMock,
      createdAt: clock(),
    };
    const rate = (await this.deps.exchangeRates.getUsdBrl()).rate;
    const recordCost = async (usage: Usage) => {
      if (!spec.provider.isMock) await assertExecutionFence();
      if (pendingVideoTask && (await this.deps.ledger.list({ jobId: ctx.job.id })).some(e => e.attemptId === attemptId)) return;
      return this.deps.ledger.record(
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
    };

    let attempt: MediaAttempt;
    try {
      const { ref, result } = await spec.run(attemptId);
      await recordCost(result.billedUsage);
      let output: { uri: string; durationSeconds: number; narration?: NarrationInfo; media?: ClipDurationCheck; audioSilence?: MediaAttempt["audioSilence"] } = {
        uri: result.uri,
        durationSeconds: result.durationSeconds,
      };
      if (spec.finalize) {
        // Fora do try: erro de posse/infra no fence nunca vira "mídia não salva" (falha de provider).
        if (!spec.provider.isMock) await assertExecutionFence();
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
        ...(output.audioSilence ? { audioSilence: output.audioSilence } : {}),
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
    if (!attempt.isMock) await assertExecutionFence();
    const { clock } = this.deps;
    const withAttempt = (list: readonly MediaAttempt[]) => [
      ...list.filter(a => a.id !== attempt.id).map((a) => (attempt.status === "succeeded" ? { ...a, active: false } : a)),
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
    if (spec.kind === "video" && (attempt.status === "succeeded" || attempt.media || attempt.error && ctx.job.videoTasks?.some(t => t.state === "settled" && t.providerJobId === attempt.providerJobId))) {
      job.videoTasks = job.videoTasks?.map(t => t.sceneId === spec.sceneId && t.state === "pending" ? { ...t, state: "settled" as const } : t);
    }
    await this.deps.store.saveJob(job);
    return { job, attempt };
  }

  /**
   * Clipes ativos para o Editor V2: duração REAL medida (janela de edição) e duração GERADA
   * (a cobrada). A edição nunca muda o billing; só escolhe a janela usada.
   */
  private editClips(job: GenerationJob, creative: CreativePlan): Map<string, EditClip> {
    const clips = new Map<string, EditClip>();
    for (const scene of creative.scenes) {
      const active = activeAttempt(job.scenes.find(s => s.sceneId === scene.id)?.attempts ?? []);
      if (!active?.assetUri) continue;
      const actual = active.media?.actualMediaDurationSeconds ?? active.durationSeconds ?? scene.estimatedGenerationSeconds;
      clips.set(scene.id, { uri: active.assetUri, actualSeconds: actual, generatedSeconds: active.media?.requestedDurationSeconds ?? actual,
        ...(active.audioSilence ? { audioSilence: active.audioSilence } : {}) });
    }
    return clips;
  }

  /**
   * Render em três passos para não segurar o lock da campanha durante minutos:
   * 1. (lock) monta o manifest e registra o RenderRecord "rendering";
   * 2. (sem lock) renderer.render() — Remotion local, sem custo de API;
   * 3. (lock) grava o desfecho: completed + output, ou failed + erro. Custo local (R$0) no ledger.
   */
  private async renderPhase(jobId: string): Promise<GenerationOutcome> {
    const { clock, ids } = this.deps;
    const current = await this.deps.store.getJob(jobId);
    this.assertHybridInvocation(current, "render");
    const renderer = this.deps.hybrid ? this.deps.hybrid.renderer(current.stageModes?.render ?? "mock") : this.deps.renderer;
    const prepared = await this.withJobLock(jobId, async () => {
      // Preparação (currentStage, manifest, registro "rendering") só com a posse do claim confirmada.
      await assertExecutionFence();
      const ctx = await this.load(jobId);
      let job = ctx.job;
      assertStatus(job, "rendering");
      const sceneVideos = new Map<string, string>();
      const clipAudioSceneIds = new Set<string>();
      for (const s of job.scenes) {
        const active = activeAttempt(s.attempts);
        if (active?.assetUri) sceneVideos.set(s.sceneId, active.assetUri);
        if (active?.ugc?.clipHasAudio) clipAudioSceneIds.add(s.sceneId);
      }
      const narration = activeAttempt(job.audioAttempts);
      const timingUri = narration?.narration?.timingUri;
      let manifest: RenderManifest;
      try {
        const timing = timingUri ? await this.deps.audioAssets.readTiming(timingUri) : undefined;
        job = await this.stage(job, "render");
        manifest = ctx.creative.editPlanVersion === 2 || ctx.creative.editPlanVersion === 3 ? buildEditedRenderManifest({
          // Editor V2: edição contínua (A-roll = espinha de áudio, B-roll overlay mudo, handles).
          campaignId: ctx.campaign.id,
          plan: ctx.creative,
          product: ctx.campaign.request.product,
          clips: this.editClips(job, ctx.creative),
          referenceImageUri: approvedReference(job.ugc)?.imageUri,
          outputDir: this.deps.outputDir,
        }) : buildRenderManifest({
          campaignId: ctx.campaign.id,
          plan: ctx.creative.scenes.some(s => s.visualSource === "presenter") && timing && narration?.durationSeconds ? alignedPresenterPlan(ctx.creative, timing, narration.durationSeconds) : ctx.creative,
          product: ctx.campaign.request.product,
          sceneVideos,
          clipAudioSceneIds,
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
      // Conclusão do render (status, versão, ledger) só com a posse do claim confirmada.
      await assertExecutionFence();
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
        renderStale: false, waitingForStage: undefined,
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
    // Lote 7: inclui tarefas na fila durável (queued/running) quando o runtime informa a atividade.
    if (this.isJobActive(jobId)) throw new JobInProgressError("Este criativo já está sendo gerado ou renderizado");
  }

  /** Lote 7: local = executa neste processo; cloud = persiste na fila e volta (o worker executa). */
  private async dispatchJob(jobId: string, run: JobRun): Promise<{ completion: Promise<GenerationOutcome> }> {
    if (!this.deps.dispatcher) return { completion: this.launchJob(jobId, () => this.runJob(jobId, run)) };
    const job = await this.getJob(jobId);
    await this.deps.dispatcher.enqueueJob(job, run);
    return { completion: Promise.resolve({ kind: "QUEUED", job }) };
  }

  private async dispatchPlanning(campaign: Campaign, realAuthorized: boolean): Promise<{ completion: Promise<Campaign> }> {
    if (this.deps.dispatcher) {
      await this.deps.dispatcher.enqueuePlanning(campaign, realAuthorized);
      return { completion: Promise.resolve(campaign) };
    }
    return { completion: realAuthorized ? withRealStageAuthorization("planning", () => this.launchPlanning(campaign)) : this.launchPlanning(campaign) };
  }

  /** Executa a descrição serializável de uma tarefa (mesmo código no processo local e no worker). */
  private async runJob(jobId: string, run: JobRun): Promise<GenerationOutcome> {
    switch (run.kind) {
      case "authorized": return this.runAuthorizedJob(jobId);
      case "hybrid_mocks": return this.runHybridMocks(jobId);
      case "continue": return this.continueGeneration(jobId);
      case "render": return this.renderPhase(jobId);
      case "narration_regen": return this.regenerateNarrationNow(jobId, run.previousStatus);
      case "hybrid_stage": {
        const outcome = await this.performHybridStage(jobId, run.stage, run.regenerate, run.sceneId);
        if (!run.thenFreeRender || outcome.kind !== "WAITING_STAGE") return outcome;
        // Recomposição local só segue sozinha quando custa zero (mesma regra de antes, agora no servidor).
        const render = await this.quoteStage(jobId, "render", true);
        if (!render.ready || render.estimatedBrl !== 0) return outcome;
        const prepared = await this.prepareStage(jobId, "render", render.token, {}, true);
        return prepared.budgetStillBlocked ? outcome : this.performHybridStage(jobId, "render");
      }
      case "scene_retry": return this.performSceneRetryIntent(jobId, run.retryIntentId);
    }
  }

  /**
   * Worker (cloud): executa UMA tarefa da fila neste processo. Mesmo registro de execução ativa
   * do modo local (assertJobIdle continua valendo dentro do processo).
   */
  runJobTask(jobId: string, run: JobRun): Promise<GenerationOutcome> {
    return this.launchJob(jobId, () => this.runJob(jobId, run));
  }

  /** Worker (cloud): planejamento persistido. Execução substituída/antiga é descartada sem custo. */
  async runPlanningTask(campaignId: string, planningRunId: string, realAuthorized: boolean): Promise<Campaign> {
    const campaign = await this.deps.store.getCampaign(campaignId);
    if (campaign.status !== "planning" || campaign.planningRunId !== planningRunId) return campaign;
    return realAuthorized ? withRealStageAuthorization("planning", () => this.launchPlanning(campaign)) : this.launchPlanning(campaign);
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
    const countedEntries = ctx.campaign.executionMode === "hybrid" ? entries.filter(e => !e.simulated) : entries;
    const snapshot = budgetSnapshot(ctx.job, jobs, countedEntries);
    if (ctx.campaign.executionMode === "hybrid") snapshot.creativeCurrentBrl = countedEntries.filter(e => e.jobId === ctx.job.id).reduce((a,e) => a+e.costBrl,0) + countedEntries.filter(e => e.jobId === null).reduce((a,e) => a+e.costBrl,0) / Math.max(1, jobs.length);
    return checkBudget({
      budget: ctx.campaign.request.budget,
      authorization: ctx.job.overBudgetAuthorization,
      ...snapshot,
      additionalBrl,
    });
  }

  private assertExecutionMode(campaign: Campaign): void {
    if ((this.deps.hybrid && !["hybrid", "offline"].includes(campaign.executionMode ?? "")) || (this.deps.offlineOnly && campaign.executionMode !== "offline")) throw new UnexpectedStatusError("Projeto anterior em consulta. Crie uma cópia offline para continuar sem alterar dados reais.");
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
    return { job, campaign, creative, pricing: resolvePricing(job.stageModes?.scenes === "real" ? { ...campaign.settings, video: RUNWAY_VIDEO } : campaign.settings, this.deps.pricing) };
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
    return (this.deps.planner).worstCase(request);
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
          if (!meta.simulated) await assertExecutionFence();
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
      if (!meta.simulated) await assertExecutionFence();
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
