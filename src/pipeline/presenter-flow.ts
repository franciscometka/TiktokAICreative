import type { Campaign, GenerationJob, MediaAttempt } from "@/domain/pipeline";
import type { CreativePlan, ScenePlan } from "@/domain/creative";
import type { PresenterTask } from "@/domain/presenter";
import type { PresenterProvider, PresenterRef } from "@/providers/presenter/presenter-provider";
import type { AudioAssetStore } from "@/storage/audio-asset-store";
import type { VideoAssetStore } from "@/storage/video-asset-store";
import type { PipelineStore } from "@/storage/pipeline-store";
import type { CostLedger } from "@/costs/ledger";
import type { Clock } from "@/lib/clock";
import type { IdGenerator } from "@/lib/ids";
import { buildActualCost, type Usage } from "@/costs/calculate";
import { activeAttempt, assertCanStartPaidCall } from "./guards";
import { alignedSceneWindows, type AudioSlicer } from "@/speech/presenter-audio";
import { waitForCompletion, type PollOptions } from "@/providers/poll";
import { ProviderError, InvalidMediaError } from "@/providers/types";
import { checkClipDuration, clipRejectionMessage } from "@/domain/media-integrity";
export class PresenterPendingError extends Error { override name = "PresenterPendingError"; }
export interface PresenterFlowDeps {
  store: PipelineStore; ledger: CostLedger; audioAssets: AudioAssetStore; videoAssets: VideoAssetStore;
  slicer: AudioSlicer; pollOptions: PollOptions; clock: Clock; ids: IdGenerator;
}
export async function presenterPreview(deps: Pick<PresenterFlowDeps, "audioAssets">, campaign: Campaign, plan: CreativePlan, job: GenerationJob, scene: ScenePlan, simulated = false) {
  const narration = activeAttempt(job.audioAttempts);
  if (simulated) {
    if (!narration?.isMock) throw new Error("Simulação exige narração mock; áudio real não é convertido em simulação.");
    const startSeconds = plan.scenes.slice(0, scene.order).reduce((sum, s) => sum + s.duration, 0);
    const window = { startSeconds, endSeconds: startSeconds + scene.duration };
    return { audioPath: narration.assetUri ?? "mock://audio", window, durationSeconds: scene.duration,
      audio: { narrationAttemptId: narration.id, narrationVersion: narration.narration?.version ?? "mock-v1", ...window } };
  }
  if (!narration || narration.isMock || !narration.assetUri || !narration.narration?.version || !narration.narration.timingUri) throw new Error("Presenter exige narração real existente com alignment (ElevenLabs); não gera outra voz.");
  const timing = await deps.audioAssets.readTiming(narration.narration.timingUri);
  if (!timing) throw new Error("Alignment real não encontrado; nenhuma chamada de presenter enviada.");
  const window = alignedSceneWindows(plan, timing, narration.durationSeconds!)[scene.order]!;
  const file = await deps.audioAssets.resolveNarrationFile({ campaignId: campaign.id, creativeId: plan.id, version: narration.narration.version });
  if (!file) throw new Error("Arquivo narration.mp3 não encontrado.");
  return { audioPath: file.absolutePath, window, durationSeconds: window.endSeconds - window.startSeconds,
    audio: { narrationAttemptId: narration.id, narrationVersion: narration.narration.version, ...window } };
}
/** Lifecycle lives here, separate from generic VideoProvider. Pipeline supplies approval/budget locks. */
export async function generatePresenter(deps: PresenterFlowDeps, input: { campaign: Campaign; plan: CreativePlan; job: GenerationJob; scene: ScenePlan; provider: PresenterProvider; exchangeRate: number; regenerate?: boolean }) {
  let { job } = input;
  const { campaign, plan, scene, provider } = input;
  assertCanStartPaidCall(job);
  let task = job.presenterTasks?.findLast(t => t.sceneId === scene.id);
  const resume = task && (task.state === "pending" || task.state === "submitting");
  const newlyApprovedRetry = task?.state === "failed" && task.estimateId !== job.approval?.estimateId;
  if (task && !resume && !input.regenerate && !newlyApprovedRetry) throw new Error("Presenter já teve uma tentativa; nova geração exige ação explícita e nova aprovação.");
  const persistTask = async (value: PresenterTask) => {
    task = value;
    const tasks = job.presenterTasks ?? [];
    job = { ...job, presenterTasks: tasks.some(t => t.attemptId === value.attemptId) ? tasks.map(t => t.attemptId === value.attemptId ? value : t) : [...tasks, value] };
    await deps.store.saveJob(job);
  };
  let prepared: Awaited<ReturnType<typeof presenterPreview>> | undefined;
  let audio: Uint8Array | undefined;
  if (!resume) {
    prepared = await presenterPreview(deps, campaign, plan, job, scene, provider.descriptor.isMock);
    const estimate = provider.estimateCost(prepared.durationSeconds);
    audio = provider.descriptor.isMock ? new Uint8Array() : await deps.slicer(prepared.audioPath, prepared.window);
    await persistTask({ attemptId: deps.ids("attempt"), sceneId: scene.id, avatarPresetId: campaign.request.presenterPresetId!,
      state: "submitting", isMock: provider.descriptor.isMock, requestedDurationSeconds: prepared.durationSeconds, audio: prepared.audio,
      estimatedCostUsd: estimate.costUsd, estimateId: job.approval!.estimateId, createdAt: deps.clock() });
  } else if (!task!.providerJobId) {
    throw new PresenterPendingError("Envio de presenter interrompido sem ID confirmado; possível cobrança. Consulte a Runway. Nenhum novo POST será feito.");
  }
  const current = () => task!;
  const recordCost = async (usage: Usage) => {
    const id = `cost_${current().attemptId}`;
    const existing = (await deps.ledger.list({ jobId: job.id })).find(e => e.id === id);
    if (existing) { await persistTask({ ...current(), actualCostUsd: existing.costUsd }); return; }
    await deps.ledger.record(buildActualCost({ id, campaignId: campaign.id, jobId: job.id, creativeId: plan.id, sceneId: scene.id,
      attemptId: current().attemptId, operation: "video_generation", category: "video", description: `Presenter — cena ${scene.order + 1}`,
      pricing: provider.descriptor.pricing, usage, exchangeRate: input.exchangeRate, simulated: provider.descriptor.isMock, createdAt: deps.clock() }));
    const entry = (await deps.ledger.list({ jobId: job.id })).find(e => e.id === id)!;
    await persistTask({ ...current(), actualCostUsd: entry.costUsd });
  };
  const previous = job.scenes.find(s => s.sceneId === scene.id)!.attempts;
  const base = () => ({ id: current().attemptId, kind: "video" as const, sceneId: scene.id, attemptNumber: previous.filter(a => a.id !== current().attemptId).length + 1,
    provider: provider.descriptor.id, model: provider.descriptor.model, isMock: provider.descriptor.isMock, createdAt: current().createdAt,
    providerJobId: current().providerJobId ?? null, requestId: current().requestId,
    presenter: { avatarPresetId: current().avatarPresetId, audio: current().audio } });
  let attempt: MediaAttempt;
  let costRecorded = false;
  try {
    if (!resume) {
      const ref = await provider.submit({ avatarPresetId: current().avatarPresetId, audio: audio!, durationSeconds: current().requestedDurationSeconds });
      await persistTask({ ...current(), ...ref, state: "pending" });
    }
    const ref: PresenterRef = { providerJobId: current().providerJobId!, requestId: current().requestId, requestedDurationSeconds: current().requestedDurationSeconds };
    await waitForCompletion(r => provider.getStatus({ ...ref, ...r }), ref, deps.pollOptions);
    const result = await provider.downloadResult(ref);
    await recordCost(result.billedUsage); costRecorded = true;
    if (result.isMock) {
      attempt = { ...base(), status: "succeeded", active: true, assetUri: result.uri, durationSeconds: result.durationSeconds };
    } else {
    if (!result.data) throw new Error("Presenter não retornou dados de vídeo.");
    const stored = await deps.videoAssets.save({ campaignId: campaign.id, sceneId: scene.id, data: result.data, metadata: {
      attemptId: current().attemptId, providerJobId: ref.providerJobId, requestId: ref.requestId, model: provider.descriptor.model,
      avatarPresetId: current().avatarPresetId, audio: current().audio, requestedDurationSeconds: current().requestedDurationSeconds,
      providerReportedDurationSeconds: result.providerReportedDurationSeconds ?? null, billedUsage: result.billedUsage } });
    const media = checkClipDuration({ requestedSeconds: current().requestedDurationSeconds, providerReportedSeconds: result.providerReportedDurationSeconds,
      actualSeconds: stored.inspection.durationSeconds, fileComplete: stored.inspection.complete });
    await deps.videoAssets.writeIntegrity?.(stored.uri, { ...media, checkedAt: deps.clock() });
    if (media.status !== "valid") throw new InvalidMediaError(clipRejectionMessage(media, scene.order + 1), media, stored.uri);
    attempt = { ...base(), status: "succeeded", active: true, assetUri: stored.uri, durationSeconds: media.actualMediaDurationSeconds!, media };
    }
  } catch (error) {
    if (error instanceof ProviderError && error.billedUsage && !costRecorded) await recordCost(error.billedUsage);
    const terminal = error instanceof ProviderError && ["FAILED", "CANCELLED"].includes(error.diagnostic?.providerStatus ?? "");
    const uncertain = error instanceof ProviderError && !error.billedUsage && error.diagnostic?.billing !== "rejected" && !terminal;
    if (uncertain) {
      await persistTask({ ...current(), diagnostic: error.diagnostic, error: error.message });
      throw new PresenterPendingError(error.message);
    }
    attempt = { ...base(), status: "failed", active: false, error: error instanceof ProviderError || error instanceof InvalidMediaError ? error.message : "Falha local ao salvar/validar presenter; custo preservado. Sem retry automático.",
      diagnostic: error instanceof ProviderError ? error.diagnostic : undefined,
      ...(error instanceof InvalidMediaError ? { media: error.media, rejectedAssetUri: error.rejectedAssetUri } : {}) };
  }
  const finalTask = { ...current(), state: attempt.status, error: attempt.error };
  job = { ...job, presenterTasks: (job.presenterTasks ?? []).map(t => t.attemptId === finalTask.attemptId ? finalTask : t),
    scenes: job.scenes.map(s => s.sceneId === scene.id ? { ...s, attempts: [...s.attempts.filter(a => a.id !== attempt.id).map(a => attempt.active ? { ...a, active: false } : a), attempt] } : s), updatedAt: deps.clock() };
  await deps.store.saveJob(job);
  return { job, attempt };
}
