import { AROLL_OPENING_POSE, AROLL_POSES, PRESENTER_POLICY } from "@/config/edit-policy";
import { CreativePlanSchema, type CreativePlan, type ScenePlan } from "@/domain/creative";
import { PRESENTER_EDIT_PLAN_VERSION, type ContinuityAction, type SceneContinuity } from "@/domain/edit";
import { isUgcPersonSource, type UgcPersonSource } from "@/domain/ugc";

/**
 * Lote 5.7 — Presenter Only (padrão do AI UGC). PURO e determinístico:
 *   - só cenas ugc_* (a apresentadora falando, segurando o produto) entram;
 *   - B-roll, foto, card e imagem estática são REMOVIDOS do plano (a arquitetura de B-roll continua
 *     no Editor V2, só com opt-in explícito);
 *   - nunca menos de 30s planejados: trechos curtos crescem até 8s (limite Veo) antes de aceitar;
 *   - continuidade encadeada (pose de entrada = pose de saída do trecho anterior);
 *   - o último trecho é fechamento + CTA falado + cauda natural (`finalTail`).
 * Idempotente para planos já V3.
 */

export const MAX_PRESENTER_CLIP_SECONDS = 8;

const round = (x: number) => Math.round(x * 100) / 100;

function continuityFor(source: UgcPersonSource, entryPose: string, revision: number, actions: { entryAction: ContinuityAction; exitAction?: ContinuityAction }): SceneContinuity {
  const pose = AROLL_POSES[source];
  return {
    // Lote 6.2 (cut on action): a entrada continua a ação com que o trecho anterior terminou.
    entryAction: actions.entryAction,
    exitAction: actions.exitAction ?? pose.exitAction,
    handPosition: "right",
    gazeDirection: pose.eyeDirection,
    continuityGroup: "presenter",
    presenterPosition: "center",
    productPosition: pose.productPosition,
    productHand: "right",
    cameraPosition: "front_eye_level",
    cameraDistance: "medium_close",
    motionDirection: pose.motionDirection,
    entryPose,
    exitPose: pose.exitPose,
    eyeDirection: pose.eyeDirection,
    environmentRevision: revision,
    outfitRevision: revision,
    identityRevision: revision,
  };
}

export function applyPresenterOnly(creative: CreativePlan, options: { identityRevision?: number; minFinalSeconds?: number } = {}): { plan: CreativePlan; adjustments: string[] } {
  if (creative.editPlanVersion === PRESENTER_EDIT_PLAN_VERSION && creative.scenes.every((s) => s.edit?.role === "aroll")) return { plan: creative, adjustments: [] };
  const adjustments: string[] = [];
  const revision = options.identityRevision ?? 1;
  const minFinal = Math.max(options.minFinalSeconds ?? PRESENTER_POLICY.minFinalSeconds, PRESENTER_POLICY.minFinalSeconds);
  for (const scene of creative.scenes) {
    if (!isUgcPersonSource(scene.visualSource)) adjustments.push(`Cena ${scene.order + 1}: ${scene.visualSource} removida (Presenter Only: a apresentadora aparece 100% do vídeo).`);
  }
  const arolls = creative.scenes.filter((s) => isUgcPersonSource(s.visualSource) && s.narration.trim());
  if (arolls.length === 0) throw new Error("AI UGC Presenter Only sem trechos da apresentadora: o plano precisa de cenas ugc_* com fala.");

  // Duração: nunca < 30s. Cresce proporcionalmente até o limite físico de cada clipe.
  let durations = arolls.map((s) => Math.min(MAX_PRESENTER_CLIP_SECONDS, Math.max(2, s.duration)));
  const sum = durations.reduce((a, b) => a + b, 0);
  if (sum < minFinal) {
    const factor = minFinal / sum;
    durations = durations.map((d) => round(Math.min(MAX_PRESENTER_CLIP_SECONDS, d * factor)));
    adjustments.push(`Duração planejada ${round(sum)}s abaixo de ${minFinal}s: trechos ampliados para ${round(durations.reduce((a, b) => a + b, 0))}s.`);
  }

  let entryPose = AROLL_OPENING_POSE;
  let entryAction: ContinuityAction = "hold_still";
  let scale = 1;
  const segments = new Map((creative.masterScript?.segments ?? []).map((s) => [s.sceneId, s]));
  const scenes = arolls.map((scene, order): ScenePlan => {
    const segment = segments.get(scene.id);
    const continuity = continuityFor(scene.visualSource as UgcPersonSource, entryPose, revision, { entryAction, ...(segment?.exitAction ? { exitAction: segment.exitAction } : {}) });
    entryPose = continuity.exitPose;
    entryAction = continuity.exitAction ?? "hold_still";
    const last = order === arolls.length - 1;
    const duration = durations[order]!;
    scale = order === 0 ? 1 : scale > 1 ? 1 : PRESENTER_POLICY.punchInScale;
    return {
      ...scene, order, duration, estimatedGenerationSeconds: duration, motion: "none", requiresGeneratedVideo: true,
      // Texto na tela: só legenda. O CTA vive na fala; um CTA textual pequeno é opcional no fim.
      onScreenText: last ? scene.onScreenText : "",
      edit: {
        version: PRESENTER_EDIT_PLAN_VERSION, role: "aroll", overlay: false, continuityGroup: continuity.continuityGroup, continuity,
        cutReason: order === 0 ? "opening" : "sentence_boundary", transition: order === 0 ? "straight_cut" : scale > 1 ? "punch_in" : "straight_cut",
        ...(last ? { finalTail: true } : {}),
      },
    };
  });
  const duration = round(scenes.reduce((s, x) => s + x.duration, 0));
  if (duration < PRESENTER_POLICY.minFinalSeconds) adjustments.push(`Atenção: só ${duration}s possíveis com ${scenes.length} trechos de até 8s; aumente o número de trechos.`);
  const plan = CreativePlanSchema.parse({
    ...creative, scenes, duration, editPlanVersion: PRESENTER_EDIT_PLAN_VERSION,
    script: scenes.map((s) => s.narration.trim()).join(" "),
  });
  return { plan, adjustments };
}

/** Prévia do storyboard Presenter Only: "Trecho N · Apresentadora · fala"; o último leva o CTA. */
export interface PresenterPreviewItem {
  sceneId: string;
  label: string;
  startSeconds: number;
  endSeconds: number;
  speech: string;
  continuity: string | null;
  isFinal: boolean;
}

export function previewPresenterTimeline(plan: Pick<CreativePlan, "scenes">): PresenterPreviewItem[] {
  let cursor = 0;
  const arolls = plan.scenes.filter((s) => s.edit?.role === "aroll");
  return arolls.map((scene, i) => {
    const isFinal = i === arolls.length - 1;
    const item = {
      sceneId: scene.id, label: `Trecho ${i + 1} · ${isFinal ? "Apresentadora + CTA" : "Apresentadora"}`,
      startSeconds: round(cursor), endSeconds: round(cursor + scene.duration), speech: scene.narration,
      continuity: scene.edit?.continuity ? `${scene.edit.continuity.entryPose} → ${scene.edit.continuity.exitPose}` : null, isFinal,
    };
    cursor += scene.duration;
    return item;
  });
}
