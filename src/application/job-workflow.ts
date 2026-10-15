import type { Campaign, GenerationJob } from "@/domain/pipeline";
import type { CreativePlan } from "@/domain/creative";
import { activeAttempt } from "@/pipeline/guards";
import type { StageQuote } from "@/domain/execution";
export type WorkflowState = "ready" | "running" | "waiting" | "paused" | "failed" | "skipped";
export interface WorkflowStep { id: string; label: string; state: WorkflowState; detail: string; simulated: boolean }
export interface RecommendedAction { label: string; detail: string; stage?: StageQuote["stage"]; ready: boolean }

export function recommendedNextAction(creative: CreativePlan, job: GenerationJob, quotes: StageQuote[], active: boolean): RecommendedAction {
  if (active) return { label: "Aguardar a etapa em andamento", detail: "A página será atualizada; não repita a ação enquanto o job estiver ativo.", ready: false };
  if (job.status === "audio_review") return { label: "Revisar duração da narração", detail: "Aceite a duração maior, gere uma nova versão explicitamente ou cancele antes de continuar.", stage: "narration", ready: true };
  const order = ["narration", "avatar", "scenes", "render"] as const;
  for (const stage of order) {
    const quote = quotes.find(item => item.stage === stage);
    if (!quote || quote.done) continue;
    const sceneId = quote.unit.split(":")[0];
    const sceneNumber = creative.scenes.find(scene => scene.id === sceneId)?.order;
    const label = stage === "narration" ? "Gerar narração" : stage === "avatar" ? `Gerar avatar${sceneNumber === undefined ? "" : ` da cena ${sceneNumber + 1}`}` : stage === "scenes" ? `Gerar cena de produto${sceneNumber === undefined ? "" : ` ${sceneNumber + 1}`}` : "Renderizar vídeo final";
    return { label, detail: quote.blocked ?? `${quote.mode.toUpperCase()} · ${quote.provider} · revise o preflight e confirme somente esta ação.`, stage, ready: quote.ready || !!quote.budgetDecision?.canAuthorizeOverBudget };
  }
  return { label: "Fluxo concluído", detail: "Todas as etapas selecionadas têm uma versão válida e o render está atualizado.", ready: false };
}
export function jobWorkflow(campaign: Campaign, creative: CreativePlan, job: GenerationJob | undefined, active: boolean): WorkflowStep[] {
  const offline = campaign.executionMode === "offline" || campaign.executionMode === "hybrid";
  const narration = job ? activeAttempt(job.audioAttempts) : undefined;
  const generic = creative.scenes.filter(s => s.requiresGeneratedVideo && s.visualSource !== "presenter");
  const avatars = creative.scenes.filter(s => s.visualSource === "presenter");
  const completed = (sceneIds: string[]) => job?.scenes.filter(s => sceneIds.includes(s.sceneId) && activeAttempt(s.attempts)).length ?? 0;
  const state = (id: string, done: boolean, skipped = false): WorkflowState => {
    if (skipped) return "skipped";
    if (done) return "ready";
    if (job?.currentStage === id) {
      if (job.status === "failed") return "failed";
      if (job.status === "budget_exceeded" || job.status === "audio_review" || !active) return "paused";
      return "running";
    }
    return "waiting";
  };
  const genericDone = completed(generic.map(s => s.id));
  const avatarDone = completed(avatars.map(s => s.id));
  return [
    { id: "script", label: "Roteiro", state: "ready", detail: campaign.request.scriptMode === "manual" ? "Texto definido por você" : offline ? "Sugestão local, sem IA externa" : "Roteiro planejado", simulated: offline && campaign.request.scriptMode !== "manual" },
    { id: "plan", label: "Planejamento", state: "ready", detail: `${creative.scenes.length} cenas · ${avatars.length} com avatar`, simulated: campaign.plannerId === "mock" },
    { id: "narration", label: "Narração", state: state("narration", !!narration), detail: narration ? `${narration.narration?.version ?? `tentativa ${narration.attemptNumber}`} · ${narration.durationSeconds?.toFixed(1) ?? "?"}s${narration.isMock ? " estimados; sem arquivo de voz" : " de áudio"}` : "Aguardando aprovação", simulated: narration?.isMock ?? offline },
    { id: "scenes", label: "Cenas", state: state("scenes", genericDone === generic.length), detail: `${genericDone}/${generic.length} vídeos de produto · imagens e textos prontos para composição`, simulated: offline && job?.stageModes?.scenes !== "real" },
    { id: "avatar", label: "Avatar", state: state("avatar", avatarDone === avatars.length, !avatars.length), detail: avatars.length ? `${avatarDone}/${avatars.length} · ${campaign.request.presenterPresetId ?? "sem avatar selecionado"}` : "Este job não usa apresentador", simulated: offline && job?.stageModes?.avatar !== "real" },
    { id: "render", label: "Render final", state: state("render", job?.status === "completed" && !!job.outputUri), detail: job?.status === "completed" ? (offline && job?.stageModes?.render !== "real") ? `Simulação concluída · ${job.renders.length} versão(ões); sem MP4` : "Render concluído" : "Aguardando cenas e narração", simulated: offline && job?.stageModes?.render !== "real" },
  ];
}
