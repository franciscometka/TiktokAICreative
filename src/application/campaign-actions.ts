import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { ActualCostSummary } from "@/costs/ledger";
import { SAFE_PRODUCT_ID } from "@/domain/upload";
import type { PipelineService } from "@/pipeline/pipeline-service";
import { StaleEstimateError } from "@/pipeline/guards";
import { FINAL_FILE, RENDER_ID, renderDir, SAFE_ENTITY_ID } from "@/render/output-paths";
import { LocalAudioAssetStore } from "@/storage/audio-asset-store";
import type { LocalUploadStore } from "@/storage/upload-store";
import { parseCampaignForm, toCampaignRequest, type FieldErrors } from "./campaign-form";
import {
  buildCampaignView,
  campaignListItem,
  imagePreviewUrl,
  type CampaignListItem,
  type CampaignView,
  type JobActivity,
} from "./campaign-view";
import { presentBudgetDecision, type BudgetDecisionPresentation } from "./cost-presentation";
import { toUserError, type UserError } from "./user-errors";

/**
 * Casos de uso da interface. Os Server Actions/route handlers do Next só chamam estas funções
 * com o runtime do processo; toda regra fica no PipelineService e no domínio.
 * Retornos são serializáveis e já no formato que a tela usa.
 */

export interface AppDeps {
  service: PipelineService;
  uploads: LocalUploadStore;
  /** Pasta dos renders (RENDERS_DIR), para servir os MP4 por ID. */
  rendersDir: string;
  /** Pasta das narrações (AUDIO_DIR), para servir o áudio por ID. */
  audioDir: string;
  /** Provider de narração configurado (só o id; nunca a chave). */
  audioProvider?: "mock" | "elevenlabs";
}

export type ActionResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: UserError; fieldErrors?: FieldErrors };

const fail = (error: unknown): { ok: false; error: UserError } => ({ ok: false, error: toUserError(error) });

// ---------------------------------------------------------------- planejamento

export async function startCampaignPlanning(
  deps: AppDeps,
  input: unknown,
): Promise<ActionResult<{ campaignId: string }>> {
  const parsed = parseCampaignForm(input);
  if (!parsed.ok) {
    return {
      ok: false,
      error: { code: "validation", title: "Revise os campos", message: "Alguns campos precisam de ajuste.", retryable: false },
      fieldErrors: parsed.error,
    };
  }
  const form = parsed.value;
  try {
    // Caminhos das imagens vêm SEMPRE do store, nunca do browser.
    const stored = await deps.uploads.resolve(form.productId, form.imageIds);
    if (stored.length !== form.imageIds.length) {
      return {
        ok: false,
        error: { code: "validation", title: "Revise as imagens", message: "Uma das imagens não existe mais.", retryable: false },
        fieldErrors: { imageIds: "Uma das imagens não foi encontrada. Remova e envie de novo." },
      };
    }
    const request = toCampaignRequest(
      form,
      stored.map((s, i) => ({ id: s.id, uri: s.uri, alt: `${form.name} — imagem ${i + 1}` })),
    );
    const { campaign, completion } = await deps.service.startPlanning(request);
    // Roda neste processo, sem segurar a request. Falhas do planner viram campanha "failed";
    // aqui só chegam falhas de I/O, que deixam a campanha "interrompida" (visível na UI).
    completion.catch((error: unknown) => console.error(`[planejamento ${campaign.id}]`, error));
    return { ok: true, value: { campaignId: campaign.id } };
  } catch (error) {
    return fail(error);
  }
}

/** Ação explícita do usuário após falha/interrupção. Nova chamada (possivelmente paga). */
export async function retryCampaignPlanning(deps: AppDeps, campaignId: string): Promise<ActionResult<{ campaignId: string }>> {
  try {
    const { campaign, completion } = await deps.service.retryPlanning(campaignId);
    completion.catch((error: unknown) => console.error(`[planejamento ${campaign.id}]`, error));
    return { ok: true, value: { campaignId } };
  } catch (error) {
    return fail(error);
  }
}

// ---------------------------------------------------------------- leitura

export async function getCampaignView(deps: AppDeps, campaignId: string): Promise<ActionResult<CampaignView>> {
  try {
    const { service } = deps;
    const campaign = await service.getCampaign(campaignId);
    const jobs = await service.listJobs(campaignId);
    const jobActuals = new Map<string, ActualCostSummary>();
    const jobActivity = new Map<string, JobActivity>();
    for (const job of jobs) {
      jobActuals.set(job.id, (await service.getJobCostReport(job.id)).actual);
      jobActivity.set(job.id, { active: service.isJobActive(job.id), progress: service.getRenderProgress(job.id) });
    }
    const view = buildCampaignView({
      campaign,
      jobs,
      planningActive: service.isPlanningActive(campaignId),
      campaignActual: await service.getCampaignCostReport(campaignId),
      jobActuals,
      jobActivity,
      audioProvider: deps.audioProvider,
    });
    return { ok: true, value: view };
  } catch (error) {
    return fail(error);
  }
}

export type CampaignListEntry =
  | { ok: true; item: CampaignListItem }
  | { ok: false; id: string; error: UserError };

/** Campanhas mais recentes primeiro. Uma campanha corrompida não derruba a lista. */
export async function listCampaigns(deps: AppDeps, limit = 50): Promise<CampaignListEntry[]> {
  const { service } = deps;
  const ids = await service.listCampaignIds();
  const entries: CampaignListEntry[] = [];
  for (const id of ids) {
    try {
      const campaign = await service.getCampaign(id);
      const actual = await service.getCampaignCostReport(id);
      entries.push({ ok: true, item: campaignListItem(campaign, service.isPlanningActive(id), actual) });
    } catch (error) {
      entries.push({ ok: false, id, error: toUserError(error) });
    }
  }
  const time = (e: CampaignListEntry) => (e.ok ? e.item.createdAt : "");
  return entries.sort((a, b) => time(b).localeCompare(time(a))).slice(0, limit);
}

// ---------------------------------------------------------------- aprovação

export type GenerationResultView =
  | { kind: "started" }
  | { kind: "completed" }
  | { kind: "budget_exceeded"; source: "approval" | "generation"; decision: BudgetDecisionPresentation }
  | { kind: "failed"; message: string }
  | { kind: "cancelled" };

function logBackground(jobId: string, completion: Promise<unknown>): void {
  completion.catch((error: unknown) => console.error(`[geração/render ${jobId}]`, error));
}

/**
 * Botão "Gerar por aproximadamente R$X": aprova a estimativa MOSTRADA (estimateId) e inicia a
 * geração + render EM BACKGROUND (a tela acompanha pelo status). Vídeo IA e áudio continuam mock.
 * Se o orçamento for excedido, devolve a decisão para o diálogo (nada é gerado).
 */
export async function approveCreative(
  deps: AppDeps,
  input: { jobId: string; estimateId: string; authorizeOverBudget?: boolean },
): Promise<ActionResult<GenerationResultView>> {
  const { service } = deps;
  try {
    const job = await service.getJob(input.jobId);
    if (job.estimate?.id !== input.estimateId) {
      throw new StaleEstimateError("A estimativa aprovada não é a estimativa atual do job");
    }
    if (job.status === "cost_estimated") await service.requestApproval(job.id);

    const approval = await service.approve(job.id, {
      estimateId: input.estimateId,
      authorizeOverBudget: input.authorizeOverBudget === true,
    });
    if (approval.kind === "BUDGET_EXCEEDED") {
      return {
        ok: true,
        value: { kind: "budget_exceeded", source: "approval", decision: presentBudgetDecision(approval.decision) },
      };
    }
    const { completion } = await service.startGeneration(job.id);
    logBackground(job.id, completion);
    return { ok: true, value: { kind: "started" } };
  } catch (error) {
    return fail(error);
  }
}

/**
 * "Renderizar novamente" / retomar após interrupção. Ação explícita; cria uma NOVA versão do MP4
 * (as anteriores ficam). Render local: sem custo de API.
 */
export async function rerenderCreative(deps: AppDeps, jobId: string): Promise<ActionResult<GenerationResultView>> {
  try {
    const { completion } = await deps.service.startRerender(jobId);
    logBackground(jobId, completion);
    return { ok: true, value: { kind: "started" } };
  } catch (error) {
    return fail(error);
  }
}

/**
 * Narração em revisão: aceitar o vídeo mais longo (fim estendido, sem cortar fala). Sem custo.
 */
export async function acceptNarration(deps: AppDeps, jobId: string): Promise<ActionResult<GenerationResultView>> {
  try {
    const { completion } = await deps.service.acceptNarration(jobId);
    logBackground(jobId, completion);
    return { ok: true, value: { kind: "started" } };
  } catch (error) {
    return fail(error);
  }
}

/**
 * Gerar a narração de novo: ação explícita, NOVA versão e NOVO custo (a anterior fica no total).
 * Orçamento excedido volta como decisão (nada é chamado); autorizar exige um segundo clique.
 */
export async function regenerateNarration(
  deps: AppDeps,
  input: { jobId: string; authorizeOverBudget?: boolean },
): Promise<ActionResult<GenerationResultView>> {
  try {
    const result = await deps.service.startNarrationRegeneration(input.jobId, {
      authorizeOverBudget: input.authorizeOverBudget === true,
    });
    if (result.kind === "BUDGET_EXCEEDED") {
      return { ok: true, value: { kind: "budget_exceeded", source: "generation", decision: presentBudgetDecision(result.decision) } };
    }
    logBackground(input.jobId, result.completion);
    return { ok: true, value: { kind: "started" } };
  } catch (error) {
    return fail(error);
  }
}

/** Pausa por orçamento DURANTE a geração: cancelar ou autorizar até o total mostrado. */
export async function resolveCreativeBudget(
  deps: AppDeps,
  input: { jobId: string; choice: "cancel" | "authorize" },
): Promise<ActionResult<GenerationResultView>> {
  try {
    const { job, completion } = await deps.service.startBudgetResolution(input.jobId, input.choice);
    if (job.status === "cancelled") return { ok: true, value: { kind: "cancelled" } };
    logBackground(input.jobId, completion);
    return { ok: true, value: { kind: "started" } };
  } catch (error) {
    return fail(error);
  }
}

export async function cancelCreative(deps: AppDeps, jobId: string): Promise<ActionResult<{ jobId: string }>> {
  try {
    await deps.service.cancel(jobId);
    return { ok: true, value: { jobId } };
  } catch (error) {
    return fail(error);
  }
}

// ---------------------------------------------------------------- uploads

export interface UploadedImageView {
  productId: string;
  id: string;
  previewUrl: string;
  size: number;
}

export function newProductId(): string {
  return `prod_${randomUUID()}`;
}

/** Sem productId (primeiro upload do formulário), o servidor gera um. Nunca aceita caminhos. */
export async function uploadProductImage(
  deps: AppDeps,
  input: { productId: string | null; file: { bytes: Uint8Array; size: number; type: string } },
): Promise<ActionResult<UploadedImageView>> {
  try {
    const productId = input.productId && SAFE_PRODUCT_ID.test(input.productId) ? input.productId : newProductId();
    const stored = await deps.uploads.save(productId, {
      bytes: input.file.bytes,
      size: input.file.size,
      declaredType: input.file.type,
    });
    return {
      ok: true,
      value: { productId, id: stored.id, previewUrl: imagePreviewUrl(productId, stored.id) ?? "", size: stored.size },
    };
  } catch (error) {
    return fail(error);
  }
}

export async function removeProductImage(
  deps: AppDeps,
  input: { productId: string; imageId: string },
): Promise<ActionResult<{ removed: boolean }>> {
  try {
    return { ok: true, value: { removed: await deps.uploads.remove(input.productId, input.imageId) } };
  } catch (error) {
    return fail(error);
  }
}

// ---------------------------------------------------------------- vídeos renderizados

export interface RenderFile {
  absolutePath: string;
  sizeBytes: number;
  fileName: string;
}

/**
 * Resolve o MP4 de um render a partir de IDs. Só serve versões REGISTRADAS no job como concluídas
 * (nada de listar pastas ou aceitar caminhos), e o caminho final passa por renderDir()
 * (regex dos IDs + contenção na pasta de renders).
 */
export async function resolveRenderFile(
  deps: AppDeps,
  ids: { campaignId: string; creativeId: string; renderId: string },
): Promise<RenderFile | undefined> {
  if (!SAFE_ENTITY_ID.test(ids.campaignId) || !SAFE_ENTITY_ID.test(ids.creativeId) || !RENDER_ID.test(ids.renderId)) {
    return undefined;
  }
  let jobs;
  try {
    jobs = await deps.service.listJobs(ids.campaignId);
  } catch {
    return undefined;
  }
  const record = jobs
    .find((j) => j.creativeId === ids.creativeId)
    ?.renders.find((r) => r.renderId === ids.renderId && r.status === "completed" && !r.isMock);
  if (!record) return undefined;
  const absolutePath = join(renderDir(deps.rendersDir, ids.campaignId, ids.creativeId, ids.renderId), FINAL_FILE);
  try {
    const info = await stat(absolutePath);
    if (!info.isFile()) return undefined;
    return { absolutePath, sizeBytes: info.size, fileName: `criativo-${ids.creativeId}-${ids.renderId}.mp4` };
  } catch {
    return undefined;
  }
}

export interface NarrationFile {
  absolutePath: string;
  sizeBytes: number;
  fileName: string;
}

/**
 * Áudio da narração por IDs (nunca por caminho). Só versões registradas numa tentativa de áudio
 * real do job; o caminho é recalculado e validado dentro de AUDIO_DIR.
 */
export async function resolveNarrationFile(
  deps: AppDeps,
  ids: { campaignId: string; creativeId: string; version: string },
): Promise<NarrationFile | undefined> {
  if (!SAFE_ENTITY_ID.test(ids.campaignId) || !SAFE_ENTITY_ID.test(ids.creativeId) || !RENDER_ID.test(ids.version)) {
    return undefined;
  }
  let jobs;
  try {
    jobs = await deps.service.listJobs(ids.campaignId);
  } catch {
    return undefined;
  }
  const registered = jobs
    .find((j) => j.creativeId === ids.creativeId)
    ?.audioAttempts.some((a) => a.status === "succeeded" && !a.isMock && a.narration?.version === ids.version);
  if (!registered) return undefined;
  const file = await new LocalAudioAssetStore(deps.audioDir).resolveNarrationFile(ids);
  return file ? { ...file, fileName: `narracao-${ids.creativeId}-${ids.version}.mp3` } : undefined;
}
