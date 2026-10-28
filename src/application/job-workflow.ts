import { approvedReference, isUgcPersonSource } from "@/domain/ugc";
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
  const reference = quotes.find(item => item.stage === "ugc_reference");
  if (reference?.awaitingReview) return { label: "Aprovar a pessoa que apresenta o produto", detail: "Aprove a referência AI UGC, gere outra ou troque apresentador/ambiente. Nenhuma cena UGC é gerada antes disso.", stage: "ugc_reference", ready: true };
  const order = ["ugc_reference", "narration", "ugc_video", "avatar", "scenes", "render"] as const;
  for (const stage of order) {
    const quote = quotes.find(item => item.stage === stage);
    if (!quote || quote.done) continue;
    const sceneId = quote.unit.split(":")[0];
    const sceneNumber = creative.scenes.find(scene => scene.id === sceneId)?.order;
    const label = stage === "ugc_reference" ? "Gerar referência AI UGC" : stage === "ugc_video" ? `Gerar cena AI UGC${sceneNumber === undefined ? "" : ` ${sceneNumber + 1}`}` : stage === "narration" ? "Gerar narração" : stage === "avatar" ? `Gerar avatar${sceneNumber === undefined ? "" : ` da cena ${sceneNumber + 1}`}` : stage === "scenes" ? `Gerar cena de produto${sceneNumber === undefined ? "" : ` ${sceneNumber + 1}`}` : "Renderizar vídeo final";
    return { label, detail: quote.blocked ?? `${quote.mode.toUpperCase()} · ${quote.provider} · revise o preflight e confirme somente esta ação.`, stage, ready: quote.ready || !!quote.budgetDecision?.canAuthorizeOverBudget };
  }
  return { label: "Fluxo concluído", detail: "Todas as etapas selecionadas têm uma versão válida e o render está atualizado.", ready: false };
}
export function jobWorkflow(campaign: Campaign, creative: CreativePlan, job: GenerationJob | undefined, active: boolean): WorkflowStep[] {
  const offline = campaign.executionMode === "offline" || campaign.executionMode === "hybrid";
  const narration = job ? activeAttempt(job.audioAttempts) : undefined;
  const generic = creative.scenes.filter(s => s.requiresGeneratedVideo && s.visualSource !== "presenter" && !isUgcPersonSource(s.visualSource));
  const ugcScenes = creative.scenes.filter(s => isUgcPersonSource(s.visualSource));
  const ugcState = job?.ugc;
  const reference = approvedReference(ugcState);
  const nativeSpeech = ugcState?.audioStrategy === "native_speech";
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
  const ugcDone = completed(ugcScenes.map(s => s.id));
  const latest = ugcState?.references.at(-1);
  const ugcSteps: WorkflowStep[] = ugcState ? [
    { id: "ugc_reference", label: "Referência UGC", state: reference ? "ready" : latest?.state === "succeeded" && latest.review === "pending" ? "paused" : state("ugc_reference", false), detail: reference ? `Aprovada · ${reference.version}${reference.isMock ? " · simulada" : ""}` : latest?.state === "succeeded" && latest.review === "pending" ? "Aguardando sua aprovação visual" : "Pessoa + produto, antes de qualquer cena UGC", simulated: job?.stageModes?.ugc_reference !== "real" },
    { id: "ugc_video", label: "Cenas UGC", state: state("ugc_video", ugcDone === ugcScenes.length), detail: `${ugcDone}/${ugcScenes.length} cenas com a mesma pessoa e o mesmo produto`, simulated: job?.stageModes?.ugc_video !== "real" },
  ] : [];
  return [
    { id: "script", label: "Roteiro", state: "ready", detail: campaign.request.scriptMode === "manual" ? "Texto definido por você" : offline ? "Sugestão local, sem IA externa" : "Roteiro planejado", simulated: offline && campaign.request.scriptMode !== "manual" },
    { id: "plan", label: "Planejamento", state: "ready", detail: `${creative.scenes.length} cenas · ${avatars.length} com avatar`, simulated: campaign.plannerId === "mock" },
    ...ugcSteps,
    { id: "narration", label: "Narração", state: state("narration", !!narration || nativeSpeech, nativeSpeech), detail: nativeSpeech ? "Fala gerada pelo próprio vídeo AI UGC (sem narração separada)" : narration ? `${narration.narration?.version ?? `tentativa ${narration.attemptNumber}`} · ${narration.durationSeconds?.toFixed(1) ?? "?"}s${narration.isMock ? " estimados; sem arquivo de voz" : " de áudio"}` : "Aguardando aprovação", simulated: narration?.isMock ?? offline },
    { id: "scenes", label: "Cenas", state: state("scenes", genericDone === generic.length), detail: `${genericDone}/${generic.length} vídeos de produto · imagens e textos prontos para composição`, simulated: offline && job?.stageModes?.scenes !== "real" },
    { id: "avatar", label: "Avatar", state: state("avatar", avatarDone === avatars.length, !avatars.length), detail: avatars.length ? `${avatarDone}/${avatars.length} · ${campaign.request.presenterPresetId ?? "sem avatar selecionado"}` : "Este job não usa apresentador", simulated: offline && job?.stageModes?.avatar !== "real" },
    { id: "render", label: "Render final", state: state("render", job?.status === "completed" && !!job.outputUri), detail: job?.status === "completed" ? (offline && job?.stageModes?.render !== "real") ? `Simulação concluída · ${job.renders.length} versão(ões); sem MP4` : "Render concluído" : "Aguardando cenas e narração", simulated: offline && job?.stageModes?.render !== "real" },
  ];
}
