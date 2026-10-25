"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  authorizeAndRunJob,
  approveUgcReference,
  regenerateUgcReference, switchJobToReal,
  updateUgcIdentity,
  regenerateStoryboardScene,
  retryFailedScene,
  updateStoryboardScene,
  executeHybridStage, configureHybridStage, executeHybridPlanning,
  acceptNarration,
  approveCreative,
  cancelCreative,
  removeProductImage,
  regenerateNarration,
  rerenderCreative,
  resolveCreativeBudget,
  retryCampaignPlanning,
  startCampaignPlanning,
  type ActionResult,
  type GenerationResultView,
} from "@/application/campaign-actions";
import { getRuntime, getV2Estimates } from "@/server/runtime";
import { changeRequestCosts, startVideoV2 } from "@/application/create-v2";
import { archiveAvatar, saveAvatar, saveVoiceProfile, setAvatarActive, type AvatarView, type VoiceProfileView } from "@/application/avatar-actions";
import { SAFE_AVATAR_ID } from "@/domain/avatar";
import { parseChangeRequest, type ChangeRequest } from "@/domain/change-request";
import { UgcEnvironmentChoiceSchema, UgcPresenterChoiceSchema } from "@/domain/ugc";
import { createHash } from "node:crypto";
import { remoteAction } from "@/server/backend";
import { runtimeMode } from "@/server/session";

/**
 * Server Actions FINAS: validam o formato dos argumentos (são endpoints públicos) e delegam
 * para application/campaign-actions. Nenhuma regra de negócio ou de custo aqui.
 */

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

/** Lote 7: no modo cloud as ações V2 vão para a Render API; as da tela técnica antiga ficam no local. */
const cloud = () => runtimeMode() === "cloud";
function localOnly<T>(): ActionResult<T> {
  return { ok: false, error: { code: "invalid_state", title: "Disponível no modo local", message: "Esta ação da tela técnica só existe no modo local. Use a tela simples do projeto.", retryable: false } };
}
/** Idempotency-Key estável para o MESMO pedido (clique duplo) numa janela de 10 minutos. */
function idempotencyKey(scope: string, input: unknown): Record<string, string> {
  const bucket = Math.floor(Date.now() / 600_000);
  return { "Idempotency-Key": `${scope}-${createHash("sha256").update(JSON.stringify([input, bucket])).digest("hex").slice(0, 40)}` };
}

function badInput<T>(): ActionResult<T> {
  return {
    ok: false,
    error: { code: "validation", title: "Pedido inválido", message: "Os dados enviados são inválidos.", retryable: false },
  };
}

export async function startPlanningAction(input: unknown): Promise<ActionResult<{ campaignId: string }>> {
  if (cloud()) return localOnly();
  const result = await startCampaignPlanning(getRuntime().deps, input);
  if (result.ok) revalidatePath("/");
  return result;
}

export async function retryPlanningAction(campaignId: unknown): Promise<ActionResult<{ campaignId: string }>> {
  const parsed = id.safeParse(campaignId);
  if (!parsed.success) return badInput();
  if (cloud()) return remoteAction("POST", `/v1/projects/${parsed.data}/retry-planning`, {});
  const result = await retryCampaignPlanning(getRuntime().deps, parsed.data);
  revalidatePath(`/campaigns/${parsed.data}`);
  return result;
}

const ApproveInput = z.object({ jobId: id, estimateId: id, authorizeOverBudget: z.boolean().optional() });

export async function approveCreativeAction(input: unknown): Promise<ActionResult<GenerationResultView>> {
  const parsed = ApproveInput.safeParse(input);
  if (!parsed.success) return badInput();
  if (cloud()) return localOnly();
  return approveCreative(getRuntime().deps, parsed.data);
}

const ResolveInput = z.object({ jobId: id, choice: z.enum(["cancel", "authorize"]) });

export async function resolveBudgetAction(input: unknown): Promise<ActionResult<GenerationResultView>> {
  const parsed = ResolveInput.safeParse(input);
  if (!parsed.success) return badInput();
  if (cloud()) return localOnly();
  return resolveCreativeBudget(getRuntime().deps, parsed.data);
}

export async function cancelCreativeAction(jobId: unknown): Promise<ActionResult<{ jobId: string }>> {
  const parsed = id.safeParse(jobId);
  if (!parsed.success) return badInput();
  if (cloud()) return remoteAction("POST", `/v1/jobs/${parsed.data}/cancel`, {});
  return cancelCreative(getRuntime().deps, parsed.data);
}

const RemoveImageInput = z.object({ productId: z.string().max(64), imageId: z.string().max(80) });

export async function removeImageAction(input: unknown): Promise<ActionResult<{ removed: boolean }>> {
  const parsed = RemoveImageInput.safeParse(input);
  if (!parsed.success) return badInput();
  if (cloud()) return remoteAction("DELETE", `/v1/uploads/${encodeURIComponent(parsed.data.productId)}/${encodeURIComponent(parsed.data.imageId)}`);
  return removeProductImage(getRuntime().deps, parsed.data);
}

export async function rerenderCreativeAction(jobId: unknown): Promise<ActionResult<GenerationResultView>> {
  const parsed = id.safeParse(jobId);
  if (!parsed.success) return badInput();
  if (cloud()) return remoteAction("POST", `/v1/jobs/${parsed.data}/retry`, {});
  return rerenderCreative(getRuntime().deps, parsed.data);
}

export async function acceptNarrationAction(jobId: unknown): Promise<ActionResult<GenerationResultView>> {
  const parsed = id.safeParse(jobId);
  if (!parsed.success) return badInput();
  if (cloud()) return localOnly();
  return acceptNarration(getRuntime().deps, parsed.data);
}

const regenerateNarrationInput = z.object({ jobId: id, authorizeOverBudget: z.boolean().optional() });

export async function regenerateNarrationAction(input: unknown): Promise<ActionResult<GenerationResultView>> {
  const parsed = regenerateNarrationInput.safeParse(input);
  if (!parsed.success) return badInput();
  if (cloud()) return localOnly();
  return regenerateNarration(getRuntime().deps, parsed.data);
}

export async function regenerateSceneAction(input: unknown): Promise<ActionResult<{ message: string }>> {
  const parsed = z.object({ jobId: id, sceneId: id }).safeParse(input);
  if (!parsed.success) return badInput();
  if (cloud()) return localOnly();
  try {
    const result = await getRuntime().deps.service.regenerateScene(parsed.data.jobId, parsed.data.sceneId);
    revalidatePath(`/campaigns/${result.job.campaignId}`);
    return { ok: true, value: { message: result.kind === "REGENERATED" ? "Nova versão gerada." : result.kind === "FAILED" ? result.error : "Limite de orçamento excedido; nenhuma nova geração autorizada." } };
  } catch { return { ok: true, value: { message: "Não foi possível iniciar a regeneração. Consulte o estado do criativo antes de repetir." } }; }
}

const StageActionInput = z.object({ jobId: id, stage: z.enum(["narration", "scenes", "avatar", "render"]), token: z.string().length(64), regenerate: z.boolean().optional(), authorizeOverBudget: z.boolean().optional(), sceneId: id.optional() });
export async function executeStageAction(input: unknown): Promise<ActionResult<{ started: boolean }>> {
  const parsed = StageActionInput.safeParse(input);
  if (!parsed.success) return badInput();
  if (cloud()) return localOnly();
  return executeHybridStage(getRuntime().deps, parsed.data);
}

export async function regenerateStoryboardSceneAction(input: unknown): Promise<ActionResult<{ started: boolean }>> {
  const parsed = z.object({ jobId: id, sceneId: id, token: z.string().length(64) }).safeParse(input);
  if (!parsed.success) return badInput();
  if (cloud()) return remoteAction("POST", `/v1/jobs/${parsed.data.jobId}/scenes/${parsed.data.sceneId}/regenerate`, { token: parsed.data.token });
  return regenerateStoryboardScene(getRuntime().deps, parsed.data);
}
export async function retryFailedSceneAction(input: unknown): Promise<ActionResult<{ started: boolean }>> {
  const parsed = z.object({ jobId: id, sceneId: id, token: z.string().length(64) }).strict().safeParse(input);
  if (!parsed.success) return badInput();
  if (cloud()) return remoteAction("POST", `/v1/jobs/${parsed.data.jobId}/scenes/${parsed.data.sceneId}/retry`, { token: parsed.data.token });
  return retryFailedScene(getRuntime().deps, parsed.data);
}
export async function configureStageAction(input: unknown): Promise<ActionResult<{ saved: boolean }>> {
  const parsed = z.object({ jobId: id, stage: z.enum(["narration", "scenes", "avatar", "ugc_reference", "ugc_video", "render"]), mode: z.enum(["mock", "real"]) }).safeParse(input);
  if (!parsed.success) return badInput();
  if (cloud()) return localOnly();
  return configureHybridStage(getRuntime().deps, parsed.data);
}
export async function executePlanningStageAction(input: unknown): Promise<ActionResult<{ started: boolean }>> {
  const parsed = z.object({ campaignId: id, token: z.string().length(64) }).safeParse(input);
  if (!parsed.success) return badInput();
  if (cloud()) return remoteAction("POST", `/v1/projects/${parsed.data.campaignId}/planning`, { token: parsed.data.token });
  return executeHybridPlanning(getRuntime().deps, parsed.data);
}

export async function authorizeJobAction(input: unknown): Promise<ActionResult<{ started: boolean }>> {
  const parsed = z.object({ jobId: id, token: z.string().length(64) }).safeParse(input);
  if (!parsed.success) return badInput();
  if (cloud()) return remoteAction("POST", `/v1/jobs/${parsed.data.jobId}/generate`, { token: parsed.data.token }, idempotencyKey("generate", parsed.data));
  const result = await authorizeAndRunJob(getRuntime().deps, parsed.data);
  if (result.ok) revalidatePath("/campaigns");
  return result;
}

export async function updateStoryboardSceneAction(input: unknown): Promise<ActionResult<{ saved: boolean }>> {
  const parsed = z.object({
    jobId: id,
    sceneId: id,
    narration: z.string().max(800),
    visualDescription: z.string().trim().min(1).max(1000),
    visualSource: z.enum(["generated_video", "product_hero", "product_demo", "lifestyle", "presenter", "product_image", "text_card", "screenshot", "simple_background", "existing_asset"]),
  }).safeParse(input);
  if (!parsed.success) return badInput();
  if (cloud()) return localOnly();
  const result = await updateStoryboardScene(getRuntime().deps, parsed.data);
  if (result.ok) revalidatePath("/campaigns");
  return result;
}

// ---------------------------------------------------------------- AI UGC (Lote 5.3)

export async function approveUgcReferenceAction(input: unknown): Promise<ActionResult<{ resumed: boolean }>> {
  // Product Fidelity Gate: confirmação humana explícita + textos divergentes opcionais (sem caminhos).
  const parsed = z.object({ jobId: id, referenceId: id, fidelityConfirmed: z.boolean(), observedTexts: z.array(z.string().trim().min(1).max(80)).max(20).optional(), confirmedSpecs: z.array(z.string().trim().min(1).max(80)).max(20).optional(), note: z.string().max(300).optional() }).safeParse(input);
  if (!parsed.success) return badInput();
  if (cloud()) { const { jobId, referenceId, ...review } = parsed.data; return remoteAction("POST", `/v1/jobs/${jobId}/references/${referenceId}/approve`, review); }
  return approveUgcReference(getRuntime().deps, parsed.data);
}

export async function regenerateUgcReferenceAction(input: unknown): Promise<ActionResult<{ resumed: boolean }>> {
  const parsed = z.object({ jobId: id, fidelityRejection: z.object({ observedTexts: z.array(z.string().trim().min(1).max(80)).max(20).optional(), note: z.string().max(300).optional() }).optional() }).safeParse(input);
  if (!parsed.success) return badInput();
  if (cloud()) return remoteAction("POST", `/v1/jobs/${parsed.data.jobId}/references/regenerate`, parsed.data.fidelityRejection ? { fidelityRejection: parsed.data.fidelityRejection } : {});
  return regenerateUgcReference(getRuntime().deps, parsed.data);
}

export async function switchJobToRealAction(input: unknown): Promise<ActionResult<{ switched: true }>> {
  const parsed = z.object({ jobId: id }).safeParse(input);
  if (!parsed.success) return badInput();
  if (cloud()) return localOnly();
  return switchJobToReal(getRuntime().deps, parsed.data);
}

export async function updateUgcIdentityAction(input: unknown): Promise<ActionResult<{ resumed: boolean }>> {
  const parsed = z.object({ jobId: id, presenter: UgcPresenterChoiceSchema.optional(), environment: UgcEnvironmentChoiceSchema.optional() }).safeParse(input);
  if (!parsed.success) return badInput();
  if (cloud()) return localOnly();
  return updateUgcIdentity(getRuntime().deps, parsed.data);
}

// ---------------------------------------------------------------- Lote 6 · UX V2

export async function startVideoV2Action(input: unknown): Promise<ActionResult<{ campaignId: string; avatarReason: string }>> {
  if (cloud()) {
    const result = await remoteAction<{ campaignId: string; avatarReason: string }>("POST", "/v1/projects", input, idempotencyKey("create", input));
    if (result.ok) { revalidatePath("/"); revalidatePath("/projects"); }
    return result;
  }
  const { deps, config } = getRuntime();
  const result = await startVideoV2({ ...deps, defaultBudget: config.defaultBudget }, input);
  if (result.ok) { revalidatePath("/"); revalidatePath("/projects"); }
  return result;
}

export async function saveAvatarAction(input: unknown): Promise<ActionResult<AvatarView>> {
  if (typeof input !== "object" || input === null) return badInput();
  if (cloud()) { const r = await remoteAction<AvatarView>("POST", "/v1/avatars", input); if (r.ok) revalidatePath("/avatars"); return r; }
  const result = await saveAvatar(getRuntime().deps, input as Record<string, unknown>);
  if (result.ok) revalidatePath("/avatars");
  return result;
}

const AvatarToggleInput = z.object({ avatarId: z.string().regex(SAFE_AVATAR_ID), active: z.boolean() });
export async function setAvatarActiveAction(input: unknown): Promise<ActionResult<AvatarView>> {
  const parsed = AvatarToggleInput.safeParse(input);
  if (!parsed.success) return badInput();
  if (cloud()) { const r = await remoteAction<AvatarView>("POST", `/v1/avatars/${parsed.data.avatarId}/active`, { active: parsed.data.active }); revalidatePath("/avatars"); return r; }
  const result = await setAvatarActive(getRuntime().deps, parsed.data.avatarId, parsed.data.active);
  revalidatePath("/avatars");
  return result;
}

export async function archiveAvatarAction(avatarId: unknown): Promise<ActionResult<{ id: string }>> {
  const parsed = z.string().regex(SAFE_AVATAR_ID).safeParse(avatarId);
  if (!parsed.success) return badInput();
  if (cloud()) { const r = await remoteAction<{ id: string }>("DELETE", `/v1/avatars/${parsed.data}`); revalidatePath("/avatars"); return r; }
  const result = await archiveAvatar(getRuntime().deps, parsed.data);
  revalidatePath("/avatars");
  return result;
}

export async function saveVoiceProfileAction(input: unknown): Promise<ActionResult<VoiceProfileView>> {
  if (cloud()) { const r = await remoteAction<VoiceProfileView>("POST", "/v1/voices", input); if (r.ok) revalidatePath("/settings"); return r; }
  const result = await saveVoiceProfile(getRuntime().deps, input);
  if (result.ok) revalidatePath("/settings");
  return result;
}

const ChangeRequestInput = z.object({ campaignId: id, text: z.string().trim().min(1).max(500) });
/** Só interpreta e estima (sem custo, sem execução). Gastar exige confirmação em outra etapa. */
export async function estimateChangeRequestAction(input: unknown): Promise<ActionResult<ChangeRequest>> {
  const parsed = ChangeRequestInput.safeParse(input);
  if (!parsed.success) return badInput();
  if (cloud()) return remoteAction("POST", `/v1/projects/${parsed.data.campaignId}/change-requests`, { text: parsed.data.text });
  try {
    const { deps } = getRuntime();
    const campaign = await deps.service.getCampaign(parsed.data.campaignId);
    const jobs = await deps.service.listJobs(campaign.id);
    const quality = campaign.request.quality === "custom" ? "high" : campaign.request.quality;
    const costs = changeRequestCosts(getV2Estimates(), campaign.request.targetDurationSeconds ?? 30, quality, jobs[0]?.voiceLock?.strategy === "locked_voice");
    return { ok: true, value: parseChangeRequest(parsed.data.text, costs) };
  } catch (error) {
    return { ok: false, error: { code: "validation", title: "Não entendemos o pedido", message: error instanceof Error ? error.message : "Tente descrever de outro jeito.", retryable: true } };
  }
}
