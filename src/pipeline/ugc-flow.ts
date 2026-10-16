import { buildUgcReferencePrompt, UGC_ROLE_ACTIONS } from "@/ai/ugc-script";
import { productAnchor, resolveUgcIdentity } from "@/config/ugc";
import { buildActualCost, type Usage } from "@/costs/calculate";
import type { CostLedger } from "@/costs/ledger";
import type { CreativePlan, ScenePlan } from "@/domain/creative";
import { checkClipDuration, clipRejectionMessage } from "@/domain/media-integrity";
import type { Campaign, GenerationJob, MediaAttempt } from "@/domain/pipeline";
import {
  approvedReference,
  isUgcPersonSource,
  UgcRequestSchema,
  type UgcAudioStrategy,
  type UgcJobState,
  type UgcReference,
} from "@/domain/ugc";
import type { Clock } from "@/lib/clock";
import type { IdGenerator } from "@/lib/ids";
import { waitForCompletion, type PollOptions } from "@/providers/poll";
import { InvalidMediaError, ProviderError } from "@/providers/types";
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
export class UgcPendingError extends Error {
  override name = "UgcPendingError";
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
  const identity = resolveUgcIdentity({ id: ids("character"), revision: 1, product: campaign.request.product, request });
  return { identity, audioStrategy, product, references: [] };
}

function upsertReference(state: UgcJobState, reference: UgcReference): UgcJobState {
  const exists = state.references.some((r) => r.id === reference.id);
  return { ...state, references: exists ? state.references.map((r) => (r.id === reference.id ? reference : r)) : [...state.references, reference] };
}

/** Gera UMA referência pessoa + produto. Nunca re-tenta; envio sem ID confirmado nunca é reenviado. */
export async function generateUgcReference(
  deps: UgcFlowDeps,
  input: { campaign: Campaign; plan: CreativePlan; job: GenerationJob; provider: UgcReferenceProvider; exchangeRate: number },
): Promise<{ job: GenerationJob; reference: UgcReference }> {
  let { job } = input;
  const { campaign, plan, provider } = input;
  assertCanStartPaidCall(job);
  const state = job.ugc;
  if (!state) throw new Error("Job sem estado AI UGC: o produto precisa de ao menos uma imagem.");
  const uncertain = state.references.findLast((r) =>
    r.identityId === state.identity.id && r.identityRevision === state.identity.revision
    && (r.state === "submitting" || r.state === "pending"));
  if (uncertain && !uncertain.providerJobId) throw new UgcPendingError("Envio anterior da referência sem ID confirmado; possível cobrança. Nenhum novo envio será feito.");

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
      prompt: buildUgcReferencePrompt(state.identity, state.product),
      product: state.product,
      estimatedCostUsd: provider.estimateCost().costUsd,
      createdAt: deps.clock(),
    }));

  const recordCost = async (usage: Usage) => {
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
      const ref = await provider.submit({ product: state.product, identity: state.identity, prompt: reference.prompt, aspectRatio: "9:16" });
      reference = await persist({ ...reference, state: "pending", providerJobId: ref.providerJobId });
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
    reference = await persist({ ...reference, version, state: "succeeded", imageUri });
  } catch (error) {
    if (error instanceof ProviderError && error.billedUsage) await recordCost(error.billedUsage);
    const uncertainNow = error instanceof ProviderError && !error.billedUsage && error.diagnostic?.billing !== "rejected";
    if (uncertainNow && !provider.descriptor.isMock) {
      await persist({ ...reference, error: error.message, diagnostic: error.diagnostic });
      throw new UgcPendingError(error.message);
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
  input: { campaign: Campaign; plan: CreativePlan; job: GenerationJob; scene: ScenePlan; provider: UgcVideoProvider; exchangeRate: number },
): Promise<{ job: GenerationJob; attempt: MediaAttempt }> {
  let { job } = input;
  const { campaign, plan, scene, provider } = input;
  assertCanStartPaidCall(job);
  if (!isUgcPersonSource(scene.visualSource)) throw new Error(`Cena ${scene.order + 1} não é uma cena AI UGC.`);
  const state = job.ugc;
  const reference = approvedReference(state);
  if (!state || !reference?.imageUri) throw new UgcReferenceRequiredError("Nenhuma cena UGC é gerada antes de existir uma referência aprovada.");
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
    ...(provider.capabilities?.supportsReferenceImages ? { additionalReferenceUris: [state.product.imageUri] } : {}),
  };
  const previous = job.scenes.find((s) => s.sceneId === scene.id)?.attempts ?? [];
  const pendingOperation = job.ugcVideoOperations?.findLast(operation => operation.sceneId === scene.id && operation.state !== "settled");
  if (pendingOperation?.state === "submitting" && !pendingOperation.providerOperationId) {
    throw new UgcPendingError("Envio anterior da cena UGC sem operation ID confirmado; possível cobrança. Nenhum novo envio será feito.");
  }
  const attemptId = pendingOperation?.attemptId ?? deps.ids("attempt");
  const quote = provider.estimateCost(request.durationSeconds);
  const consistency = {
    role: scene.visualSource, referenceId: reference.id, referenceVersion: reference.version, identityId: state.identity.id,
    identityRevision: state.identity.revision, wardrobe: state.identity.wardrobe, environment: state.identity.environment,
    productImageId: state.product.imageId, audioStrategy: state.audioStrategy, clipHasAudio: state.audioStrategy === "native_speech",
    speech: request.speech, action: request.action,
  };
  const base = { id: attemptId, kind: "video" as const, sceneId: scene.id, attemptNumber: previous.length + 1, provider: provider.descriptor.id, model: provider.descriptor.model, isMock: provider.descriptor.isMock, createdAt: deps.clock() };
  const recordCost = async (usage: Usage) => {
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
    let ref = providerJobId ? { providerJobId } : undefined;
    if (!ref) {
      if (!provider.descriptor.isMock) {
        await persistOperation({
          attemptId, sceneId: scene.id, state: "submitting", provider: provider.descriptor.id, model: provider.descriptor.model,
          referenceId: reference.id, referenceVersion: reference.version, requestedDurationSeconds: quote.quantity,
          estimatedCostUsd: quote.costUsd, createdAt: deps.clock(),
        });
      }
      ref = await provider.submit(request);
      providerJobId = ref.providerJobId;
      if (!provider.descriptor.isMock) {
        await persistOperation({
          attemptId, sceneId: scene.id, state: "pending", providerOperationId: ref.providerJobId,
          provider: provider.descriptor.id, model: provider.descriptor.model, referenceId: reference.id,
          referenceVersion: reference.version, requestedDurationSeconds: quote.quantity,
          estimatedCostUsd: quote.costUsd, createdAt: pendingOperation?.createdAt ?? deps.clock(),
        });
      }
    }
    await waitForCompletion((r) => provider.getStatus(r), ref, deps.pollOptions);
    const result = await provider.downloadResult(ref);
    await recordCost(result.billedUsage);
    if (!provider.descriptor.isMock) await persistOperation({
      attemptId, sceneId: scene.id, state: "settled", providerOperationId: ref.providerJobId,
      provider: provider.descriptor.id, model: provider.descriptor.model, referenceId: reference.id,
      referenceVersion: reference.version, requestedDurationSeconds: quote.quantity,
      estimatedCostUsd: quote.costUsd, createdAt: pendingOperation?.createdAt ?? deps.clock(),
    });
    if (result.hasAudio !== consistency.clipHasAudio) throw new Error("O clipe UGC não respeitou a estratégia de áudio declarada; não será usado para evitar áudio duplicado.");
    if (result.isMock) {
      attempt = { ...base, providerJobId, status: "succeeded", active: true, assetUri: result.uri, durationSeconds: result.durationSeconds, ugc: consistency };
    } else {
      if (!result.data || !deps.videoAssets) throw new Error("Vídeo UGC real sem dados ou armazenamento indisponível.");
      const requested = result.requestedDurationSeconds ?? request.durationSeconds;
      const stored = await deps.videoAssets.save({ campaignId: campaign.id, sceneId: scene.id, data: result.data, metadata: { attemptId, providerJobId, provider: provider.descriptor.id, model: provider.descriptor.model, ugc: consistency, requestedDurationSeconds: requested } });
      const media = checkClipDuration({ requestedSeconds: requested, providerReportedSeconds: result.providerReportedDurationSeconds, actualSeconds: stored.inspection.durationSeconds, fileComplete: stored.inspection.complete });
      if (media.status !== "valid") throw new InvalidMediaError(clipRejectionMessage(media, scene.order + 1), media, stored.uri);
      attempt = { ...base, providerJobId, status: "succeeded", active: true, assetUri: stored.uri, durationSeconds: media.actualMediaDurationSeconds ?? requested, media, ugc: consistency };
    }
  } catch (error) {
    if (error instanceof ProviderError && error.billedUsage) await recordCost(error.billedUsage);
    if (!provider.descriptor.isMock && error instanceof ProviderError && !error.billedUsage && error.diagnostic?.billing !== "rejected") {
      throw new UgcPendingError(`${error.message} A operação ${providerJobId ?? "sem ID"} não será reenviada automaticamente.`);
    }
    if (!provider.descriptor.isMock && providerJobId) {
      const operation = job.ugcVideoOperations?.find(item => item.attemptId === attemptId);
      if (operation) await persistOperation({ ...operation, state: "settled", providerOperationId: providerJobId });
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
  await deps.store.saveJob(job);
  return { job, attempt };
}
