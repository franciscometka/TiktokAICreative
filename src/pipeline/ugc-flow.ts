import { createHash } from "node:crypto";
import { buildUgcReferencePrompt, UGC_ROLE_ACTIONS } from "@/ai/ugc-script";
import { productAnchor, resolveUgcIdentity } from "@/config/ugc";
import { buildActualCost, type Usage } from "@/costs/calculate";
import type { CostLedger } from "@/costs/ledger";
import type { CreativePlan, ScenePlan } from "@/domain/creative";
import { checkClipDuration, clipRejectionMessage } from "@/domain/media-integrity";
import { assertExecutionFence, ExecutionLeaseLostError } from "@/config/execution-policy";
import type { Campaign, GenerationJob, MediaAttempt } from "@/domain/pipeline";
import { fidelityPromptLines, initialFidelity } from "@/domain/fidelity";
import {
  approvedReference,
  AVATAR_IDENTITY_UNSUPPORTED,
  avatarIdentityImageUri,
  fidelityReleasesVideo,
  identityStrategyOf,
  isUgcPersonSource,
  type UgcCharacterIdentity,
  UgcRequestSchema,
  type UgcAudioStrategy,
  type UgcJobState,
  type UgcReference,
} from "@/domain/ugc";
import type { Clock } from "@/lib/clock";
import type { AvatarSnapshot } from "@/domain/avatar";
import type { IdGenerator } from "@/lib/ids";
import { waitForCompletion, type PollOptions } from "@/providers/poll";
import { InvalidMediaError, ProviderError, type ProviderJobRef } from "@/providers/types";
import type { UgcReferenceProvider, UgcVideoProvider, UgcVideoRequest } from "@/providers/ugc/ugc-providers";
import type { AudioSlicer } from "@/speech/presenter-audio";
import type { AudioAssetStore } from "@/storage/audio-asset-store";
import type { PipelineStore } from "@/storage/pipeline-store";
import type { ReferenceMime, UgcAssetStore } from "@/storage/ugc-asset-store";
import type { VideoAssetStore } from "@/storage/video-asset-store";
import { assertCanStartPaidCall } from "./guards";
import { presenterPreview } from "./presenter-flow";

/**
 * Ciclo de vida do AI UGC (Lote 5.3), separado do Presenter:
 *   referência (pessoa + produto) → aprovação explícita → cenas UGC a partir da referência aprovada.
 * O pipeline fornece lock, aprovação do job, orçamento e limite de tentativas; aqui ficam a
 * intenção durável, o ledger por tentativa e a consistência (mesma pessoa/roupa/ambiente/produto).
 */

export class UgcReferenceRequiredError extends Error {
  override name = "UgcReferenceRequiredError";
}
/** Fidelidade do produto não confirmada ou com conflito conhecido: nada segue automaticamente. */
export class UgcFidelityError extends Error {
  override name = "UgcFidelityError";
}
/**
 * Avatar salvo com foto + provider que não aceita referência de identidade: bloqueia ANTES de
 * qualquer chamada paga. Nunca troca a pessoa do avatar por uma identidade sintética.
 */
export class UgcIdentityUnsupportedError extends Error {
  override name = "UgcIdentityUnsupportedError";
  constructor(message = AVATAR_IDENTITY_UNSUPPORTED) { super(message); }
}

/** O provider consegue preservar a identidade pedida? (undefined = sim; string = motivo do bloqueio). */
export function identityBlockReason(identity: UgcCharacterIdentity, provider: Pick<UgcReferenceProvider, "supportsIdentityReference">): string | undefined {
  return avatarIdentityImageUri(identity) && provider.supportsIdentityReference !== true ? AVATAR_IDENTITY_UNSUPPORTED : undefined;
}

/** Revisão humana da referência (Product Fidelity Gate). */
export interface UgcFidelityReview {
  fidelityConfirmed: boolean;
  /** Textos/números divergentes vistos na imagem (ex.: "3900"). */
  observedTexts?: string[];
  /** Especificações exatas conferidas uma a uma (ex.: ["2100W", "220V"]); obrigatórias quando existem. */
  confirmedSpecs?: string[];
  note?: string;
}

export class UgcPendingError extends Error {
  override name = "UgcPendingError";
}
/** O custo recalculado antes do envio passou do aprovado: pausa e pede nova aprovação, sem rede. */
export class UgcCostChangedError extends Error {
  override name = "UgcCostChangedError";
}

/** Hash estável dos inputs da chamada paga (auditoria da intenção; nunca contém segredo). */
export function ugcInputHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
}

function assertWithinApproved(costUsd: number, maxCostUsd: number | undefined): void {
  if (maxCostUsd !== undefined && costUsd > maxCostUsd + 1e-9) {
    throw new UgcCostChangedError(`Custo recalculado US${costUsd.toFixed(4)} acima do aprovado US${maxCostUsd.toFixed(4)}. Revise e aprove novamente; nada foi enviado.`);
  }
}

/** Classificação A/B/C do erro do provider (D86). */
function errorPhase(error: unknown, isMock: boolean): "rejected" | "failed" | "uncertain" {
  if (!(error instanceof ProviderError) || isMock) return "failed";
  if (error.billedUsage) return "failed";
  if (error.diagnostic?.billing === "rejected" || error.diagnostic?.operation === "none") return "rejected";
  if (error.diagnostic?.operation === "created") return "failed";
  return "uncertain";
}

export interface UgcFlowDeps {
  store: PipelineStore;
  ledger: CostLedger;
  ugcAssets?: UgcAssetStore;
  videoAssets?: VideoAssetStore;
  audioAssets: AudioAssetStore;
  slicer: AudioSlicer;
  pollOptions: PollOptions;
  clock: Clock;
  ids: IdGenerator;
}

/** Estado inicial do job AI UGC: identidade estável + produto-âncora + estratégia de áudio. */
export function initialUgcState(campaign: Campaign, ids: IdGenerator, audioStrategy: UgcAudioStrategy): UgcJobState | undefined {
  const product = productAnchor(campaign.request.product);
  if (!product) return undefined;
  const request = UgcRequestSchema.parse(campaign.request.ugc ?? {});
  const avatar = campaign.request.avatar?.snapshot;
  const identity = resolveUgcIdentity({ id: ids("character"), revision: 1, product: campaign.request.product, request, ...(avatar ? { avatar, voiceDescription: avatarVoiceDescription(avatar) } : {}) });
  return { identity, audioStrategy, product, references: [] };
}

/** Descrição estável da voz do avatar (repetida no prompt de todos os trechos com fala nativa). */
export function avatarVoiceDescription(avatar: Pick<AvatarSnapshot, "gender" | "speakingStyle" | "personality" | "voiceName">): string {
  const who = avatar.gender === "woman" ? "adult female" : "adult male";
  return [`${who} Brazilian Portuguese voice`, avatar.speakingStyle || avatar.personality || "natural and friendly", "medium natural pace"].filter(Boolean).join(", ");
}

function upsertReference(state: UgcJobState, reference: UgcReference): UgcJobState {
  const exists = state.references.some((r) => r.id === reference.id);
  return { ...state, references: exists ? state.references.map((r) => (r.id === reference.id ? reference : r)) : [...state.references, reference] };
}

/** Gera UMA referência pessoa + produto. Nunca re-tenta; envio sem ID confirmado nunca é reenviado. */
export async function generateUgcReference(
  deps: UgcFlowDeps,
  input: { campaign: Campaign; plan: CreativePlan; job: GenerationJob; provider: UgcReferenceProvider; exchangeRate: number; maxCostUsd?: number },
): Promise<{ job: GenerationJob; reference: UgcReference }> {
  let { job } = input;
  const { campaign, plan, provider } = input;
  assertCanStartPaidCall(job);
  const state = job.ugc;
  if (!state) throw new Error("Job sem estado AI UGC: o produto precisa de ao menos uma imagem.");
  const uncertain = state.references.findLast((r) =>
    r.identityId === state.identity.id && r.identityRevision === state.identity.revision
    && (r.state === "submitting" || r.state === "pending" || r.state === "uncertain"));
  const paidSubmissionStarted = uncertain?.metadata?.paidSubmissionStarted === true;
  if (uncertain && (uncertain.state === "uncertain" || (!uncertain.providerJobId && (!provider.prepare || paidSubmissionStarted)))) {
    throw new UgcPendingError("Envio anterior da referência sem ID confirmado; possível cobrança. Nenhum novo envio será feito.");
  }
  // Avatar salvo com foto: o provider PRECISA receber a foto; sem suporte, nada é enviado/cobrado.
  const blockedIdentity = identityBlockReason(state.identity, provider);
  if (blockedIdentity) throw new UgcIdentityUnsupportedError(blockedIdentity);
  const identityImageUri = avatarIdentityImageUri(state.identity);
  const identityStrategy = identityStrategyOf(state.identity);
  const constraints = state.product.fidelityConstraints ?? [];
  const prompt = buildUgcReferencePrompt(state.identity, state.product, fidelityPromptLines(constraints));
  const estimatedCostUsd = provider.estimateCost().costUsd;
  if (!uncertain) assertWithinApproved(estimatedCostUsd, input.maxCostUsd);

  const persist = async (reference: UgcReference) => {
    job = { ...job, ugc: upsertReference(job.ugc!, reference), updatedAt: deps.clock() };
    await deps.store.saveJob(job);
    return reference;
  };

  let reference: UgcReference =
    uncertain ??
    (await persist({
      id: deps.ids("ugcref"),
      version: `v${state.references.length + 1}`,
      state: "submitting",
      review: "pending",
      identityId: state.identity.id,
      identityRevision: state.identity.revision,
      provider: provider.descriptor.id,
      model: provider.descriptor.model,
      isMock: provider.descriptor.isMock,
      prompt,
      product: state.product,
      estimatedCostUsd,
      fidelity: initialFidelity(constraints),
      identityStrategy,
      ...(state.identity.avatarReferenceAsset && identityImageUri ? { avatarReferenceAsset: state.identity.avatarReferenceAsset } : {}),
      inputHash: ugcInputHash({ stage: "ugc_reference", jobId: job.id, model: provider.descriptor.model, prompt, productImageId: state.product.imageId, identityId: state.identity.id, identityRevision: state.identity.revision, ...(identityImageUri ? { identityImageUri } : {}) }),
      ...(input.maxCostUsd === undefined ? {} : { maxApprovedCostUsd: input.maxCostUsd }),
      createdAt: deps.clock(),
    }));

  const recordCost = async (usage: Usage) => {
    if (!provider.descriptor.isMock) await assertExecutionFence();
    const id = `cost_${reference.id}`;
    if ((await deps.ledger.list({ jobId: job.id })).some((e) => e.id === id)) return;
    await deps.ledger.record(buildActualCost({
      id, campaignId: campaign.id, jobId: job.id, creativeId: plan.id, sceneId: null, attemptId: reference.id,
      operation: "ugc_reference_generation", category: "ugc_reference", description: `Referência AI UGC ${reference.version}`,
      pricing: provider.descriptor.pricing, usage, exchangeRate: input.exchangeRate, simulated: provider.descriptor.isMock, createdAt: deps.clock(),
    }));
    const entry = (await deps.ledger.list({ jobId: job.id })).find((e) => e.id === id);
    reference = await persist({ ...reference, actualCostUsd: entry?.costUsd });
  };

  try {
    if (!reference.providerJobId) {
      const request = { product: state.product, identity: state.identity, prompt: reference.prompt, aspectRatio: "9:16" as const, ...(identityImageUri ? { identityImage: { uri: identityImageUri } } : {}) };
      let prepared;
      if (provider.prepare) {
        prepared = await provider.prepare(request, reference.metadata);
        reference = await persist({ ...reference, metadata: { ...(reference.metadata ?? {}), ...prepared.metadata } });
      }
      if (!provider.descriptor.isMock) {
        await assertExecutionFence();
        reference = await persist({ ...reference, metadata: { ...(reference.metadata ?? {}), paidSubmissionStarted: true } });
        await assertExecutionFence();
      }
      const ref = await provider.submit(request, prepared);
      reference = await persist({ ...reference, state: "pending", providerJobId: ref.providerJobId, ...(ref.requestId ? { requestId: ref.requestId } : {}) });
    }
    const ref = { providerJobId: reference.providerJobId! };
    await waitForCompletion((r) => provider.getStatus(r), ref, deps.pollOptions);
    const result = await provider.downloadResult(ref);
    await recordCost(result.billedUsage);
    let imageUri = result.uri;
    let version = reference.version;
    if (!result.isMock) {
      if (!result.data || !deps.ugcAssets) throw new Error("Referência real sem dados ou armazenamento indisponível.");
      const stored = await deps.ugcAssets.saveReference({
        campaignId: campaign.id, creativeId: plan.id, data: result.data, mimeType: result.mimeType as ReferenceMime,
        metadata: { referenceId: reference.id, providerJobId: ref.providerJobId, provider: provider.descriptor.id, model: provider.descriptor.model, identity: state.identity, product: state.product, prompt: reference.prompt, width: result.width, height: result.height },
      });
      imageUri = stored.uri;
      version = stored.version;
    }
    if (!provider.descriptor.isMock) await assertExecutionFence();
    reference = await persist({ ...reference, version, state: "succeeded", imageUri, ...(result.requestId ? { requestId: result.requestId } : {}),
      ...(result.metadata ? { metadata: { ...(reference.metadata ?? {}), ...result.metadata } } : {}) });
  } catch (error) {
    if (error instanceof ExecutionLeaseLostError) throw error;
    if (error instanceof ProviderError && error.billedUsage) await recordCost(error.billedUsage);
    if (errorPhase(error, provider.descriptor.isMock) === "uncertain") {
      const message = error instanceof Error ? error.message : "Resultado incerto";
      // Sem ID: incerto, bloqueia reenvio. Com ID: retomável por polling/download, nunca novo submit.
      await persist({ ...reference, state: reference.providerJobId ? "pending" : "uncertain", error: message, diagnostic: (error as ProviderError).diagnostic });
      throw new UgcPendingError(message);
    }
    reference = await persist({ ...reference, state: "failed", error: error instanceof Error ? error.message : "Falha ao gerar a referência", diagnostic: error instanceof ProviderError ? error.diagnostic : undefined });
  }
  return { job, reference };
}

/**
 * Gera UMA cena UGC a partir da referência APROVADA. Sem referência aprovada para a identidade
 * atual: UgcReferenceRequiredError, nenhum envio.
 */
export async function generateUgcScene(
  deps: UgcFlowDeps,
  input: { campaign: Campaign; plan: CreativePlan; job: GenerationJob; scene: ScenePlan; provider: UgcVideoProvider; exchangeRate: number; maxCostUsd?: number },
): Promise<{ job: GenerationJob; attempt: MediaAttempt }> {
  let { job } = input;
  const { campaign, plan, scene, provider } = input;
  assertCanStartPaidCall(job);
  if (!isUgcPersonSource(scene.visualSource)) throw new Error(`Cena ${scene.order + 1} não é uma cena AI UGC.`);
  const state = job.ugc;
  const reference = approvedReference(state);
  if (!state || !reference?.imageUri) throw new UgcReferenceRequiredError("Nenhuma cena UGC é gerada antes de existir uma referência aprovada.");
  if (!provider.descriptor.isMock && reference.isMock) throw new UgcReferenceRequiredError("A referência aprovada é simulada (MOCK); gere uma referência real antes das cenas UGC.");
  // Product Fidelity Gate: sem revisão de fidelidade aprovada, nenhuma cena é enviada.
  if (!fidelityReleasesVideo(reference, provider.descriptor.isMock ? "mock" : "real")) {
    throw new UgcReferenceRequiredError("Confirme a fidelidade do produto na referência (logo, textos, números e especificações) antes de gerar as cenas.");
  }
  if (provider.audioStrategy !== state.audioStrategy) throw new Error("O provider UGC mudou de estratégia de áudio; crie uma cópia do projeto para replanejar.");

  let audio: UgcVideoRequest["audio"];
  if (state.audioStrategy === "external_lipsync") {
    const prepared = await presenterPreview(deps, campaign, plan, job, scene, provider.descriptor.isMock);
    audio = {
      data: provider.descriptor.isMock ? new Uint8Array() : await deps.slicer(prepared.audioPath, prepared.window),
      startSeconds: prepared.window.startSeconds,
      endSeconds: prepared.window.endSeconds,
      narrationVersion: prepared.audio.narrationVersion,
    };
  }
  const request: UgcVideoRequest = {
    sceneId: scene.id, role: scene.visualSource, reference: { id: reference.id, version: reference.version, imageUri: reference.imageUri, approved: true },
    identity: state.identity, product: state.product, speech: scene.narration, action: scene.videoDirection?.subjectAction || UGC_ROLE_ACTIONS[scene.visualSource],
    durationSeconds: audio ? audio.endSeconds - audio.startSeconds : scene.estimatedGenerationSeconds, aspectRatio: "9:16", audio,
    ...(scene.edit?.continuity ? { continuity: scene.edit.continuity } : {}),
    ...(scene.edit?.finalTail ? { finalTail: true } : {}),
    fidelity: fidelityPromptLines(state.product.fidelityConstraints ?? []),
    ...(provider.capabilities?.supportsReferenceImages ? { additionalReferenceUris: [state.product.imageUri] } : {}),
  };
  const previous = job.scenes.find((s) => s.sceneId === scene.id)?.attempts ?? [];
  const pendingOperation = job.ugcVideoOperations?.findLast(operation => operation.sceneId === scene.id && operation.state !== "settled");
  if (pendingOperation && !pendingOperation.providerOperationId && (pendingOperation.state === "uncertain"
    || (pendingOperation.state === "submitting" && (!provider.prepare || pendingOperation.metadata?.paidSubmissionStarted === true)))) {
    throw new UgcPendingError("Envio anterior da cena UGC sem operation ID confirmado; possível cobrança. Nenhum novo envio será feito.");
  }
  const attemptId = pendingOperation?.attemptId ?? deps.ids("attempt");
  const quote = provider.estimateCost(request.durationSeconds);
  if (!pendingOperation) assertWithinApproved(quote.costUsd, input.maxCostUsd);
  const intent = {
    jobId: job.id, stage: "ugc_video" as const,
    inputHash: ugcInputHash({ stage: "ugc_video", jobId: job.id, model: provider.descriptor.model, sceneId: scene.id, referenceId: reference.id, referenceVersion: reference.version, identityRevision: state.identity.revision, speech: request.speech, action: request.action, seconds: quote.quantity }),
    ...(input.maxCostUsd === undefined ? {} : { maxApprovedCostUsd: input.maxCostUsd }),
  };
  const consistency = {
    role: scene.visualSource, referenceId: reference.id, referenceVersion: reference.version, identityId: state.identity.id,
    identityRevision: state.identity.revision, wardrobe: state.identity.wardrobe, environment: state.identity.environment,
    productImageId: state.product.imageId, audioStrategy: state.audioStrategy, clipHasAudio: state.audioStrategy === "native_speech",
    speech: request.speech, action: request.action,
  };
  const base = { id: attemptId, kind: "video" as const, sceneId: scene.id, attemptNumber: previous.length + 1, provider: provider.descriptor.id, model: provider.descriptor.model, isMock: provider.descriptor.isMock, createdAt: deps.clock() };
  const recordCost = async (usage: Usage) => {
    if (!provider.descriptor.isMock) await assertExecutionFence();
    if ((await deps.ledger.list({ jobId: job.id })).some(entry => entry.attemptId === attemptId && entry.operation === "ugc_video_generation")) return;
    await deps.ledger.record(buildActualCost({
      id: `cost_${attemptId}`, campaignId: campaign.id, jobId: job.id, creativeId: plan.id, sceneId: scene.id, attemptId,
      operation: "ugc_video_generation", category: "ugc_scene", description: `Cena AI UGC ${scene.order + 1} (tentativa ${base.attemptNumber})`,
      pricing: provider.descriptor.pricing, usage, exchangeRate: input.exchangeRate, simulated: provider.descriptor.isMock, createdAt: deps.clock(),
    }));
  };

  const persistOperation = async (operation: NonNullable<GenerationJob["ugcVideoOperations"]>[number]) => {
    const operations = job.ugcVideoOperations ?? [];
    job = {
      ...job,
      ugcVideoOperations: operations.some(item => item.attemptId === operation.attemptId)
        ? operations.map(item => item.attemptId === operation.attemptId ? operation : item)
        : [...operations, operation],
      updatedAt: deps.clock(),
    };
    await deps.store.saveJob(job);
  };

  let attempt: MediaAttempt;
  let providerJobId: string | null = pendingOperation?.providerOperationId ?? null;
  try {
    let ref: ProviderJobRef | undefined = providerJobId
      ? { providerJobId, ...(pendingOperation?.requestId ? { requestId: pendingOperation.requestId } : {}) }
      : undefined;
    if (!ref) {
      if (!provider.descriptor.isMock) {
        await assertExecutionFence();
        await persistOperation({
          ...intent, attemptId, sceneId: scene.id, state: "submitting", provider: provider.descriptor.id, model: provider.descriptor.model,
          referenceId: reference.id, referenceVersion: reference.version, requestedDurationSeconds: quote.quantity,
          estimatedCostUsd: quote.costUsd, createdAt: deps.clock(),
        });
      }
      let prepared;
      if (provider.prepare) {
        prepared = await provider.prepare(request, pendingOperation?.metadata);
        const preparing = job.ugcVideoOperations?.find(item => item.attemptId === attemptId);
        if (preparing) await persistOperation({ ...preparing, metadata: { ...(preparing.metadata ?? {}), ...prepared.metadata }, updatedAt: deps.clock() });
      }
      if (!provider.descriptor.isMock) {
        const preparedOperation = job.ugcVideoOperations?.find(item => item.attemptId === attemptId);
        if (preparedOperation) await persistOperation({ ...preparedOperation, metadata: { ...(preparedOperation.metadata ?? {}), paidSubmissionStarted: true }, updatedAt: deps.clock() });
        await assertExecutionFence();
      }
      ref = await provider.submit(request, prepared);
      providerJobId = ref.providerJobId;
      if (!provider.descriptor.isMock) {
        await persistOperation({
          ...intent, attemptId, sceneId: scene.id, state: "pending", providerOperationId: ref.providerJobId,
          provider: provider.descriptor.id, model: provider.descriptor.model, referenceId: reference.id,
          referenceVersion: reference.version, requestedDurationSeconds: quote.quantity,
          estimatedCostUsd: quote.costUsd, ...(ref.requestId ? { requestId: ref.requestId } : {}), metadata: job.ugcVideoOperations?.find(item => item.attemptId === attemptId)?.metadata,
          createdAt: pendingOperation?.createdAt ?? deps.clock(),
        });
      }
    }
    await waitForCompletion((r) => provider.getStatus(r), ref, deps.pollOptions);
    const result = await provider.downloadResult(ref);
    // Duração faturável: a do provider ou a persistida na intenção (retomada após reinício).
    const billedSeconds = result.requestedDurationSeconds ?? pendingOperation?.requestedDurationSeconds ?? quote.quantity;
    await recordCost(!provider.descriptor.isMock && result.billedUsage.seconds === undefined ? { ...result.billedUsage, seconds: billedSeconds } : result.billedUsage);
    if (!provider.descriptor.isMock) await persistOperation({
      ...intent, outcome: "succeeded", updatedAt: deps.clock(),
      attemptId, sceneId: scene.id, state: "settled", providerOperationId: ref.providerJobId,
      provider: provider.descriptor.id, model: provider.descriptor.model, referenceId: reference.id,
      referenceVersion: reference.version, requestedDurationSeconds: quote.quantity,
      estimatedCostUsd: quote.costUsd, ...(ref.requestId ? { requestId: ref.requestId } : {}), metadata: job.ugcVideoOperations?.find(item => item.attemptId === attemptId)?.metadata,
      createdAt: pendingOperation?.createdAt ?? deps.clock(),
    });
    // REAL: a trilha de áudio é conferida no MP4 salvo (auditável); mock: pela declaração.
    if (result.isMock && result.hasAudio !== consistency.clipHasAudio) throw new Error("O clipe UGC não respeitou a estratégia de áudio declarada; não será usado para evitar áudio duplicado.");
    if (result.isMock) {
      attempt = { ...base, providerJobId, ...(ref.requestId ? { requestId: ref.requestId } : {}), status: "succeeded", active: true, assetUri: result.uri, durationSeconds: result.durationSeconds, ugc: consistency };
    } else {
      if (!result.data || !deps.videoAssets) throw new Error("Vídeo UGC real sem dados ou armazenamento indisponível.");
      const requested = billedSeconds;
      const stored = await deps.videoAssets.save({ campaignId: campaign.id, sceneId: scene.id, data: result.data, metadata: { attemptId, providerJobId, provider: provider.descriptor.id, model: provider.descriptor.model, ugc: consistency, requestedDurationSeconds: requested } });
      const media = checkClipDuration({ requestedSeconds: requested, providerReportedSeconds: result.providerReportedDurationSeconds, actualSeconds: stored.inspection.durationSeconds, fileComplete: stored.inspection.complete });
      if (media.status !== "valid") throw new InvalidMediaError(clipRejectionMessage(media, scene.order + 1), media, stored.uri);
      if (consistency.clipHasAudio && !stored.inspection.hasAudioTrack) throw new InvalidMediaError(`Cena ${scene.order + 1}: o MP4 não tem trilha de áudio nativo; não será usado.`, media, stored.uri);
      attempt = { ...base, providerJobId, ...(ref.requestId ? { requestId: ref.requestId } : {}), status: "succeeded", active: true, assetUri: stored.uri, durationSeconds: media.actualMediaDurationSeconds ?? requested, media, ugc: consistency,
        ...(stored.audioSilence ? { audioSilence: stored.audioSilence } : {}) };
    }
  } catch (error) {
    if (error instanceof ExecutionLeaseLostError) throw error;
    if (error instanceof ProviderError && error.billedUsage) await recordCost(error.billedUsage);
    const operation = job.ugcVideoOperations?.find(item => item.attemptId === attemptId);
    const message = error instanceof Error ? error.message : "Falha na cena UGC; sem retry automático.";
    const diagnostic = error instanceof ProviderError ? error.diagnostic : undefined;
    if (errorPhase(error, provider.descriptor.isMock) === "uncertain") {
      // C) incerto: com operation ID segue retomável (polling/download); sem ID, bloqueia reenvio.
      if (operation) await persistOperation({ ...operation, state: providerJobId ? "pending" : "uncertain", ...(providerJobId ? { providerOperationId: providerJobId } : {}), error: message, diagnostic, updatedAt: deps.clock() });
      throw new UgcPendingError(`${message} A operação ${providerJobId ?? "sem ID"} não será reenviada automaticamente.`);
    }
    // A) rejeitada antes da operação ou B) falhou depois: desfecho final, nunca reenviado sozinho.
    if (!provider.descriptor.isMock && operation) {
      await persistOperation({ ...operation, state: "settled", ...(providerJobId ? { providerOperationId: providerJobId } : {}), outcome: error instanceof InvalidMediaError ? "invalid_media" : "failed", error: message, diagnostic, updatedAt: deps.clock() });
    }
    attempt = {
      ...base, providerJobId: error instanceof ProviderError ? (error.providerJobId ?? providerJobId) : providerJobId, status: "failed", active: false,
      error: error instanceof Error ? error.message : "Falha na cena UGC; sem retry automático.", ugc: consistency,
      ...(error instanceof InvalidMediaError ? { media: error.media, rejectedAssetUri: error.rejectedAssetUri } : {}),
    };
  }
  job = {
    ...job,
    scenes: job.scenes.map((s) => (s.sceneId === scene.id ? { ...s, attempts: [...s.attempts.map((a) => (attempt.active ? { ...a, active: false } : a)), attempt] } : s)),
    updatedAt: deps.clock(),
  };
  if (!provider.descriptor.isMock) await assertExecutionFence();
  await deps.store.saveJob(job);
  return { job, attempt };
}
