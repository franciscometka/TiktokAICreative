"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  approveCreative,
  cancelCreative,
  removeProductImage,
  resolveCreativeBudget,
  retryCampaignPlanning,
  startCampaignPlanning,
  type ActionResult,
  type GenerationResultView,
} from "@/application/campaign-actions";
import { getRuntime } from "@/server/runtime";

/**
 * Server Actions FINAS: validam o formato dos argumentos (são endpoints públicos) e delegam
 * para application/campaign-actions. Nenhuma regra de negócio ou de custo aqui.
 */

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

function badInput<T>(): ActionResult<T> {
  return {
    ok: false,
    error: { code: "validation", title: "Pedido inválido", message: "Os dados enviados são inválidos.", retryable: false },
  };
}

export async function startPlanningAction(input: unknown): Promise<ActionResult<{ campaignId: string }>> {
  const result = await startCampaignPlanning(getRuntime().deps, input);
  if (result.ok) revalidatePath("/");
  return result;
}

export async function retryPlanningAction(campaignId: unknown): Promise<ActionResult<{ campaignId: string }>> {
  const parsed = id.safeParse(campaignId);
  if (!parsed.success) return badInput();
  const result = await retryCampaignPlanning(getRuntime().deps, parsed.data);
  revalidatePath(`/campaigns/${parsed.data}`);
  return result;
}

const ApproveInput = z.object({ jobId: id, estimateId: id, authorizeOverBudget: z.boolean().optional() });

export async function approveCreativeAction(input: unknown): Promise<ActionResult<GenerationResultView>> {
  const parsed = ApproveInput.safeParse(input);
  if (!parsed.success) return badInput();
  return approveCreative(getRuntime().deps, parsed.data);
}

const ResolveInput = z.object({ jobId: id, choice: z.enum(["cancel", "authorize"]) });

export async function resolveBudgetAction(input: unknown): Promise<ActionResult<GenerationResultView>> {
  const parsed = ResolveInput.safeParse(input);
  if (!parsed.success) return badInput();
  return resolveCreativeBudget(getRuntime().deps, parsed.data);
}

export async function cancelCreativeAction(jobId: unknown): Promise<ActionResult<{ jobId: string }>> {
  const parsed = id.safeParse(jobId);
  if (!parsed.success) return badInput();
  return cancelCreative(getRuntime().deps, parsed.data);
}

const RemoveImageInput = z.object({ productId: z.string().max(64), imageId: z.string().max(80) });

export async function removeImageAction(input: unknown): Promise<ActionResult<{ removed: boolean }>> {
  const parsed = RemoveImageInput.safeParse(input);
  if (!parsed.success) return badInput();
  return removeProductImage(getRuntime().deps, parsed.data);
}
