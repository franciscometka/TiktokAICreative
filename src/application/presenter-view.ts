import type { Campaign, GenerationJob } from "@/domain/pipeline";
import type { CreativePlan } from "@/domain/creative";
import { PRICING_TABLE } from "@/config/pricing";
import { RUNWAY_PRESENTER, presenterBilledSeconds } from "@/config/presenters";
export interface PresenterSceneView {
  sceneId: string; label: string; avatar: string; status: string; estimateUsd: number; actualUsd: number | null;
  simulated?: boolean;
  duration: number | null; videoUrl: string | null; canRegenerate: boolean; error: string | null;
}
export function presenterSceneViews(campaign: Campaign, plan: CreativePlan, job: GenerationJob | undefined): PresenterSceneView[] {
  return plan.scenes.filter(s => s.visualSource === "presenter").map(s => {
    const task = job?.presenterTasks?.findLast(t => t.sceneId === s.id);
    const attempt = job?.scenes.find(state => state.sceneId === s.id)?.attempts.findLast(a => a.active && a.status === "succeeded");
    const version = attempt?.assetUri?.replaceAll("\\", "/").match(/\/(v[0-9]+)\/clip.mp4$/)?.[1];
    return { sceneId: s.id, label: `Cena ${s.order + 1}`, avatar: task?.avatarPresetId ?? campaign.request.presenterPresetId ?? "não selecionado",
      status: task?.state === "pending" ? "Aguardando Runway" : task?.state === "submitting" ? "Envio iniciado — não repetir" : task?.state === "succeeded" ? "Pronto" : task?.state === "failed" ? "Falhou" : "Aguardando aprovação/narração",
      estimateUsd: task?.estimatedCostUsd ?? presenterBilledSeconds(s.duration) * PRICING_TABLE.find(p => p.model === RUNWAY_PRESENTER.model)!.priceUsd,
      simulated: task?.isMock ?? campaign.executionMode === "offline",
      actualUsd: task?.actualCostUsd ?? null, duration: attempt?.isMock ? attempt.durationSeconds ?? null : attempt?.media?.actualMediaDurationSeconds ?? null,
      videoUrl: version ? `/api/video/${campaign.id}/${plan.id}/${s.id}/${version}` : null,
      canRegenerate: job?.status === "completed" && task?.state !== "pending" && task?.state !== "submitting", error: task?.error ?? attempt?.error ?? null };
  });
}
