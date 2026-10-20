import { StageModesSchema, ExecutionStageSchema } from "./execution";
import { ProviderDiagnosticSchema } from "./provider-diagnostic";
import { ClipDurationCheckSchema } from "./media-integrity";
import { z } from "zod";
import { AvatarPresetSchema, PresenterTaskSchema, PresenterAudioSchema } from "./presenter";
import { NarrationInfoSchema } from "./audio";
import { CreativeModeSchema, UgcJobStateSchema, UgcRequestSchema, UgcSceneConsistencySchema, UgcVideoOperationSchema } from "./ugc";
import { CampaignPlanSchema } from "./campaign";
import {
  BudgetExceededDecisionSchema,
  CostBudgetSchema,
  CostEstimateSchema,
  OverBudgetAuthorizationSchema,
} from "./cost";
import { CreativeStyleSchema } from "./creative";
import { CreativeReviewSchema } from "./plan-evaluation";
import { ProductInputSchema } from "./product";
import { GenerationQualitySchema, QualitySettingsSchema } from "./quality";
import { RenderManifestSchema, RenderRecordSchema } from "./render";
import { AudioSilenceAnalysisSchema } from "./edit";
import { AvatarSelectionSchema } from "./avatar";
import { MasterAudioAssetSchema, VoiceLockDecisionSchema, VoiceLockRequestSchema } from "./video-speech";

const nonEmpty = z.string().trim().min(1);

/**
 * Duas máquinas de estado:
 * - Campaign: planejamento (uma chamada de LLM gera vários criativos).
 * - GenerationJob: um por criativo; controla custo, aprovação e geração de mídia.
 * Transições permitidas em pipeline/states.ts.
 */

export const CAMPAIGN_STATUSES = ["draft", "planning", "planned", "failed"] as const;
export const CampaignStatusSchema = z.enum(CAMPAIGN_STATUSES);
export type CampaignStatus = z.infer<typeof CampaignStatusSchema>;

export const JOB_STATUSES = [
  "planned",
  "cost_estimated",
  "awaiting_approval",
  "generating",
  "budget_exceeded",
  /** Narração real bem mais longa que o planejado: espera decisão explícita (Lote 4). */
  "audio_review",
  "rendering",
  "completed",
  "failed",
  "cancelled",
] as const;
export const JobStatusSchema = z.enum(JOB_STATUSES);
export type JobStatus = z.infer<typeof JobStatusSchema>;

/**
 * "auto": o usuário deixou o planejamento escolher os ângulos — `styles` contém todos os formatos.
 * "manual": o usuário escolheu os formatos de `styles`. Ausente = "manual" (dados do Lote 1).
 */
export const StyleSelectionSchema = z.enum(["auto", "manual"]);
export type StyleSelection = z.infer<typeof StyleSelectionSchema>;

export const CampaignRequestSchema = z.object({
  simpleFlow: z.boolean().optional(),
  enrichProduct: z.boolean().optional(),
  stageModes: StageModesSchema.optional(),
  projectName: z.string().trim().max(120).optional(),
  videoConcept: z.string().trim().max(2000).optional(),
  scriptMode: z.enum(["manual", "generate"]).optional(),
  script: z.string().trim().max(3000).optional(),
  product: ProductInputSchema,
  styles: z.array(CreativeStyleSchema).min(1),
  styleSelection: StyleSelectionSchema.optional(),
  creativeCount: z.int().min(1).max(10),
  quality: GenerationQualitySchema,
  /** Obrigatório quando quality = "custom". */
  customSettings: QualitySettingsSchema.optional(),
  budget: CostBudgetSchema,
  /** Perfil de voz da narração (config/voices.ts). Ausente = perfil padrão. */
  speakerProfileId: z.string().optional(),
  presenterPresetId: AvatarPresetSchema.optional(),
  presenterChoice: z.enum(["woman", "man", "none"]).optional(),
  /** Modo principal. Ausente = "standard" (campanhas anteriores). */
  creativeMode: CreativeModeSchema.optional(),
  /** Só com creativeMode = "ai_ugc": apresentador, ambiente e estilo visual. */
  ugc: UgcRequestSchema.optional(),
  /** Lote 6: projeto criado pela UX V2 (foto + ideia + avatar + duração). Ausente = fluxo antigo. */
  uxVersion: z.literal(2).optional(),
  /** Lote 6: duração escolhida (30/45/60s); define trechos e palavras do roteiro mestre. */
  targetDurationSeconds: z.union([z.literal(30), z.literal(45), z.literal(60)]).optional(),
  /** Lote 6: avatar usado (revisão congelada) e o motivo da escolha. */
  avatar: AvatarSelectionSchema.optional(),
  /** Lote 6: "Personalizar" (opcional). */
  personalization: z.object({
    tone: z.string().trim().max(120).optional(),
    cta: z.string().trim().max(200).optional(),
    style: z.string().trim().max(60).optional(),
    environmentText: z.string().trim().max(160).optional(),
  }).optional(),
  /** Lote 6: Voice Lock pedido pelo usuário. */
  voiceLock: VoiceLockRequestSchema.optional(),
});
export type CampaignRequest = z.infer<typeof CampaignRequestSchema>;

/**
 * Motivo tipado da falha do planejamento — a UI escolhe a mensagem a partir dele.
 * "interrupted": o processo caiu (ou reiniciou) com a campanha em "planning".
 */
export const CAMPAIGN_ERROR_CODES = [
  "not_configured",
  "auth_error",
  "rate_limited",
  "timeout",
  "connection_error",
  "invalid_response",
  "stopped",
  "provider_error",
  "interrupted",
  "unknown",
] as const;
export const CampaignErrorCodeSchema = z.enum(CAMPAIGN_ERROR_CODES);
export type CampaignErrorCode = z.infer<typeof CampaignErrorCodeSchema>;

export const CampaignSchema = z.object({
  planningApproval: z.object({ quoteToken: z.string(), estimatedBrl: z.number().nonnegative(), approvedAt: z.string() }).optional(),
  executionMode: z.enum(["offline", "real", "hybrid"]).optional(),
  id: nonEmpty,
  status: CampaignStatusSchema,
  request: CampaignRequestSchema,
  settings: QualitySettingsSchema,
  plan: CampaignPlanSchema.optional(),
  /** Avaliação de cada criativo contra o preset e ajustes determinísticos aplicados. */
  reviews: z.array(CreativeReviewSchema).optional(),
  /** Planner usado (ex.: "anthropic", "mock") — simulado ou real. */
  plannerId: z.string().optional(),
  jobIds: z.array(nonEmpty),
  error: z.string().optional(),
  errorCode: CampaignErrorCodeSchema.optional(),
  /**
   * Identifica a execução de planejamento em andamento. Uma execução que termina depois de
   * outra ter sido iniciada (ex.: retomada após interrupção) só registra custos, não o plano.
   */
  planningRunId: z.string().optional(),
  planningStartedAt: z.string().optional(),
  /** Quantas vezes o planejamento foi iniciado (1 = primeira). Cada execução pode ter custo. */
  planningRuns: z.int().positive().optional(),
  createdAt: nonEmpty,
  updatedAt: nonEmpty,
});
export type Campaign = z.infer<typeof CampaignSchema>;

export const MediaKindSchema = z.enum(["video", "audio"]);
export type MediaKind = z.infer<typeof MediaKindSchema>;

/** Uma chamada a um provider. Toda tentativa fica registrada, inclusive as descartadas. */
export const MediaAttemptSchema = z.object({
  id: nonEmpty,
  kind: MediaKindSchema,
  sceneId: z.string().nullable(),
  attemptNumber: z.int().positive(),
  provider: nonEmpty,
  model: nonEmpty,
  providerJobId: z.string().nullable(),
  status: z.enum(["succeeded", "failed"]),
  /** Apenas a tentativa ativa entra no vídeo final; as demais são descartadas (mas custam). */
  active: z.boolean(),
  assetUri: z.string().optional(),
  durationSeconds: z.number().nonnegative().optional(),
  isMock: z.boolean(),
  error: z.string().optional(),
  diagnostic: ProviderDiagnosticSchema.optional(),
  requestId: z.string().optional(),
  presenter: z.object({ avatarPresetId: AvatarPresetSchema, audio: PresenterAudioSchema }).optional(),
  /**
   * Vídeo real: duração pedida × informada pelo provider × medida do arquivo salvo. Clipe fora da
   * tolerância é rejeitado (tentativa "failed", nunca ativa, nunca vai ao render; custo mantido).
   */
  media: ClipDurationCheckSchema.optional(),
  /** Pausas medidas localmente no áudio nativo; usadas pelo Editor V2 para cortes seguros. */
  audioSilence: AudioSilenceAnalysisSchema.optional(),
  /** Arquivo de um clipe REJEITADO (guardado só para auditoria; nunca usado no render). */
  rejectedAssetUri: z.string().optional(),
  /** Só em tentativas de áudio (Lote 4+): voz, request id, versão, timing e AudioFit. */
  narration: NarrationInfoSchema.optional(),
  /** Cena AI UGC: referência, identidade, roupa, ambiente, produto e estratégia de áudio usados. */
  ugc: UgcSceneConsistencySchema.optional(),
  createdAt: nonEmpty,
});
export type MediaAttempt = z.infer<typeof MediaAttemptSchema>;

export const SceneGenerationStateSchema = z.object({
  sceneId: nonEmpty,
  order: z.int().nonnegative(),
  requiresGeneratedVideo: z.boolean(),
  attempts: z.array(MediaAttemptSchema),
});
export type SceneGenerationState = z.infer<typeof SceneGenerationStateSchema>;

export const ApprovalSchema = z.object({
  /** A aprovação vale apenas para ESTA estimativa. Nova estimativa invalida a aprovação. */
  estimateId: nonEmpty,
  approvedTotalBrl: z.number().nonnegative(),
  approvedAt: nonEmpty,
  overBudget: z.boolean(),
});
export type Approval = z.infer<typeof ApprovalSchema>;

export const GenerationJobSchema = z.object({
  /** Autorização única do fluxo simples. O teto cobre apenas novas chamadas deste job. */
  jobAuthorization: z.object({
    quoteToken: z.string(),
    estimatedBrl: z.number().nonnegative(),
    maximumAuthorizedBrl: z.number().nonnegative(),
    baselineActualBrl: z.number().nonnegative(),
    status: z.enum(["active", "paused", "completed"]),
    approvedAt: z.string(),
    pausedReason: z.string().optional(),
  }).optional(),
  storyboardRevision: z.number().int().nonnegative().optional(),
  stageIntents: z.array(z.object({ stage: ExecutionStageSchema, unit: z.string(), state: z.enum(["running", "settled"]), createdAt: z.string() })).optional(),
  renderStale: z.boolean().optional(),
  stageModes: StageModesSchema.optional(),
  stageRevision: z.number().int().nonnegative().optional(),
  waitingForStage: ExecutionStageSchema.optional(),
  stageApprovals: z.array(z.object({ mode: z.enum(["mock", "real"]).optional(), provider: z.string().optional(), model: z.string().optional(), stage: ExecutionStageSchema, unit: z.string(), quoteToken: z.string(), estimatedBrl: z.number().nonnegative(), approvedAt: z.string() })).optional(),
  currentStage: z.enum(["narration", "scenes", "avatar", "ugc_reference", "ugc_video", "render"]).optional(),
  /** AI UGC: identidade do personagem, produto-âncora e referências versionadas (pessoa + produto). */
  ugc: UgcJobStateSchema.optional(),
  /** Lote 6: avatar e revisão usados por este job (alterar o avatar depois não muda o job). */
  avatar: z.object({ avatarId: z.string(), avatarRevision: z.int().positive() }).optional(),
  /** Lote 6: estratégia de voz decidida (LOCKED_VOICE ou nativa) com o motivo. */
  voiceLock: VoiceLockDecisionSchema.optional(),
  /** Lote 6: áudio mestre (narração contínua) e os intervalos de cada trecho, quando LOCKED_VOICE. */
  masterAudio: MasterAudioAssetSchema.optional(),
  /** Intenções/operações Veo persistidas para retomada sem POST duplicado. */
  ugcVideoOperations: z.array(UgcVideoOperationSchema).optional(),
  presenterTasks: z.array(PresenterTaskSchema).optional(),
  videoTasks: z.array(z.object({ attemptId: z.string().optional(), state: z.enum(["submitting", "pending", "settled"]).optional(), sceneId: z.string(), providerJobId: z.string(), provider: z.string(), model: z.string(), createdAt: z.string() })).optional(),
  id: nonEmpty,
  campaignId: nonEmpty,
  creativeId: nonEmpty,
  status: JobStatusSchema,
  scenes: z.array(SceneGenerationStateSchema),
  audioAttempts: z.array(MediaAttemptSchema),
  estimate: CostEstimateSchema.optional(),
  approval: ApprovalSchema.optional(),
  overBudgetAuthorization: OverBudgetAuthorizationSchema.optional(),
  pendingBudgetDecision: BudgetExceededDecisionSchema.optional(),
  manifest: RenderManifestSchema.optional(),
  outputUri: z.string().optional(),
  /** Histórico de renderizações (Lote 3). A última concluída é a de outputUri. */
  renders: z.array(RenderRecordSchema).default([]),
  error: z.string().optional(),
  createdAt: nonEmpty,
  updatedAt: nonEmpty,
});
export type GenerationJob = z.infer<typeof GenerationJobSchema>;
