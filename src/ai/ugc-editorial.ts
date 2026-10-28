import { AROLL_OPENING_POSE, AROLL_POSES, DEFAULT_DETAIL_CROP, EDIT_POLICY, UGC_EDITORIAL_PLANS, type BrollPlanEntry } from "@/config/edit-policy";
import type { PresetQuality } from "@/config/quality-presets";
import { CreativePlanSchema, type CreativePlan, type ScenePlan } from "@/domain/creative";
import { EDIT_PLAN_VERSION, type CutReason, type SceneContinuity, type SceneEdit } from "@/domain/edit";
import { isUgcPersonSource, type UgcPersonSource } from "@/domain/ugc";

/**
 * Normalização editorial do AI UGC (Creative Editor V2, Lote 5.6). PURA e determinística: recebe o
 * plano (mock ou Claude, ainda linear) e devolve um plano editorial:
 *   - cenas ugc_* viram A-ROLL (espinha de áudio, fala nativa);
 *   - o resto vira B-ROLL overlay: entra por cima do áudio do A-roll numa JUNÇÃO entre A-rolls,
 *     escondendo a emenda; nunca soma na duração nem toca áudio;
 *   - catálogo (foto em fundo branco/blur, card de texto) é PROIBIDO por padrão: vira recorte do
 *     frame de referência aprovado (`reference_detail`), salvo estilo comercial explícito;
 *   - todo trecho ganha motivo de corte, transição discreta e continuidade encadeada
 *     (a pose de entrada de um A-roll é a pose de saída do anterior).
 * Planos já editoriais (editPlanVersion=2) são devolvidos sem mudança (idempotente).
 */

/** Limite físico de um clipe A-roll (Veo: 4/6/8s). */
export const MAX_AROLL_SECONDS = 8;

export interface EditorialOptions {
  /** Estilo comercial explícito do usuário: permite foto de catálogo como B-roll. */
  commercialStyle?: boolean;
  /** Faixa de duração final do preset; A-rolls só crescem se a soma ficar abaixo do mínimo. */
  finalRange?: { min: number; max: number };
  identityRevision?: number;
  /** Preset: dá o recorte/motivo de cada B-roll de referência (por ordem de junção). */
  quality?: PresetQuality;
}

export interface EditorialResult {
  plan: CreativePlan;
  adjustments: string[];
}

const round = (x: number) => Math.round(x * 100) / 100;
const clamp = (x: number, min: number, max: number) => Math.min(max, Math.max(min, x));

function arollReason(previous: ScenePlan | undefined, source: UgcPersonSource): { cutReason: CutReason; transition: SceneEdit["transition"] } {
  if (!previous) return { cutReason: "opening", transition: "straight_cut" };
  const fromBroll = previous.edit?.role === "broll";
  if (source === "ugc_cta") return { cutReason: "cta_return", transition: fromBroll ? "cut_on_action" : "punch_in" };
  return fromBroll ? { cutReason: "action_match", transition: "cut_on_action" } : { cutReason: "sentence_boundary", transition: "punch_in" };
}

function continuityFor(source: UgcPersonSource, entryPose: string, revision: number): SceneContinuity {
  const pose = AROLL_POSES[source];
  return {
    continuityGroup: "aroll-main",
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

const BROLL_REASONS: readonly SceneEdit["cutReason"][] = ["product_reveal", "detail_emphasis", "hand_occlusion"];

export function applyUgcEditorial(creative: CreativePlan, options: EditorialOptions = {}): EditorialResult {
  if (creative.editPlanVersion === EDIT_PLAN_VERSION && creative.scenes.every((s) => s.edit)) return { plan: creative, adjustments: [] };
  const adjustments: string[] = [];
  const revision = options.identityRevision ?? 1;
  const arolls = creative.scenes.filter((s) => isUgcPersonSource(s.visualSource));
  if (arolls.length === 0) throw new Error("AI UGC sem A-roll: o plano precisa de cenas ugc_* com a apresentadora.");

  // 1) Catálogo proibido por padrão: foto/card viram detalhe do frame de referência.
  const converted = creative.scenes.map((scene): ScenePlan => {
    if (isUgcPersonSource(scene.visualSource) || scene.visualSource === "product_broll" || scene.visualSource === "reference_detail") return scene;
    if (options.commercialStyle && scene.visualSource === "product_image") return scene;
    adjustments.push(`Cena ${scene.order + 1}: ${scene.visualSource} (visual de catálogo) trocado por detalhe do frame de referência.`);
    return { ...scene, visualSource: "reference_detail", motion: "none", requiresGeneratedVideo: false, estimatedGenerationSeconds: 0, generationPrompt: "", narration: "",
      onScreenText: "", visualDescription: "Detalhe do produto na mão da apresentadora (recorte do frame de referência aprovado)." };
  });

  // 2) Posições: B-roll só em JUNÇÃO entre A-rolls; no máximo um por junção.
  const ordered: ScenePlan[] = [];
  const brollDurations: number[] = [];
  let pendingBroll: ScenePlan | undefined;
  let seenAroll = 0;
  for (const scene of converted) {
    if (isUgcPersonSource(scene.visualSource)) {
      if (pendingBroll && seenAroll > 0) ordered.push(pendingBroll);
      else if (pendingBroll) adjustments.push(`Cena ${pendingBroll.order + 1}: B-roll antes do gancho removido (o vídeo abre na apresentadora).`);
      pendingBroll = undefined;
      ordered.push(scene);
      seenAroll++;
      continue;
    }
    brollDurations.push(scene.duration);
    if (pendingBroll) adjustments.push(`Cena ${scene.order + 1}: segundo B-roll na mesma junção removido (corte sem motivo).`);
    else pendingBroll = scene;
  }
  if (pendingBroll) {
    // B-roll depois do último A-roll: entra na junção anterior ao CTA, se ainda livre.
    const lastIndex = ordered.length - 1;
    const beforeLast = ordered[lastIndex - 1];
    if (ordered.length >= 2 && beforeLast && isUgcPersonSource(beforeLast.visualSource)) ordered.splice(lastIndex, 0, pendingBroll);
    else adjustments.push(`Cena ${pendingBroll.order + 1}: B-roll depois do CTA removido (o CTA mantém a apresentadora).`);
  }

  // 3) Durações: A-roll é a espinha. Só cresce se a soma ficar abaixo do mínimo do preset.
  const arollSum = arolls.reduce((sum, s) => sum + s.duration, 0);
  const missing = options.finalRange ? Math.max(0, options.finalRange.min - arollSum) : 0;
  const growthPool = Math.min(missing, brollDurations.reduce((a, b) => a + b, 0) || missing);

  let previous: ScenePlan | undefined;
  let entryPose = AROLL_OPENING_POSE;
  let brollIndex = 0;
  const hints = (options.quality ? UGC_EDITORIAL_PLANS[options.quality] : []).filter((e): e is BrollPlanEntry => e.role === "broll");
  const scenes = ordered.map((scene, order): ScenePlan => {
    let next: ScenePlan;
    if (isUgcPersonSource(scene.visualSource)) {
      const grow = arollSum > 0 ? growthPool * (scene.duration / arollSum) : 0;
      const duration = round(clamp(scene.duration + grow, 2, MAX_AROLL_SECONDS));
      if (duration !== scene.duration) adjustments.push(`Cena ${scene.order + 1}: A-roll ajustado de ${scene.duration}s para ${duration}s (espinha contínua do vídeo).`);
      const continuity = continuityFor(scene.visualSource, entryPose, revision);
      entryPose = continuity.exitPose;
      next = {
        ...scene, order, duration, estimatedGenerationSeconds: duration, motion: "none",
        edit: { version: EDIT_PLAN_VERSION, role: "aroll", overlay: false, continuityGroup: continuity.continuityGroup, continuity, ...arollReason(previous, scene.visualSource) },
      };
    } else {
      const generated = scene.visualSource === "product_broll";
      const hint = hints[brollIndex];
      const duration = round(clamp(scene.duration, EDIT_POLICY.broll.minSeconds, EDIT_POLICY.broll.maxSeconds));
      next = {
        ...scene, order, duration, narration: "", onScreenText: "",
        ...(generated ? { estimatedGenerationSeconds: round(Math.min(Math.max(scene.estimatedGenerationSeconds, duration), duration)) } : {}),
        edit: {
          version: EDIT_PLAN_VERSION, role: "broll", overlay: true, cutReason: hint?.cutReason ?? BROLL_REASONS[brollIndex % BROLL_REASONS.length]!, transition: "cut_on_action",
          continuityGroup: "detail", brollKind: generated ? "generated_context" : scene.visualSource === "product_image" ? "product_photo" : "reference_detail",
          ...(scene.visualSource === "reference_detail" ? { crop: hint?.crop ?? DEFAULT_DETAIL_CROP } : {}),
          detail: generated ? "mão no produto, mesmo ambiente" : hint?.detail ?? "produto na mão, de perto",
        },
      };
      brollIndex++;
    }
    previous = next;
    return next;
  });

  const duration = round(scenes.filter((s) => !s.edit?.overlay).reduce((sum, s) => sum + s.duration, 0));
  const plan = CreativePlanSchema.parse({
    ...creative, scenes, duration, editPlanVersion: EDIT_PLAN_VERSION,
    script: scenes.map((s) => s.narration).filter(Boolean).join(" "),
  });
  return { plan, adjustments };
}

/**
 * Prévia editorial do storyboard (planejada, antes de existir mídia): trechos na ordem com início/fim
 * na timeline final. B-roll aparece sobre a junção, com o áudio do A-roll continuando.
 */
export interface EditorialPreviewItem {
  sceneId: string;
  role: "aroll" | "broll";
  startSeconds: number;
  endSeconds: number;
  speech: string;
  visual: string;
  cutReason: CutReason;
  audioFrom: string | null;
  continuity?: string;
}

export function previewEditorialTimeline(plan: Pick<CreativePlan, "scenes">): EditorialPreviewItem[] {
  const items: EditorialPreviewItem[] = [];
  let cursor = 0;
  let lastAroll: ScenePlan | undefined;
  for (const scene of plan.scenes) {
    if (!scene.edit) continue;
    if (scene.edit.role === "aroll") {
      items.push({ sceneId: scene.id, role: "aroll", startSeconds: round(cursor), endSeconds: round(cursor + scene.duration), speech: scene.narration, visual: scene.visualDescription,
        cutReason: scene.edit.cutReason, audioFrom: null, continuity: scene.edit.continuity ? `${scene.edit.continuity.entryPose} → ${scene.edit.continuity.exitPose}` : undefined });
      cursor += scene.duration;
      lastAroll = scene;
    } else {
      const tail = scene.duration * EDIT_POLICY.junctionTailShare;
      items.push({ sceneId: scene.id, role: "broll", startSeconds: round(Math.max(0, cursor - tail)), endSeconds: round(cursor - tail + scene.duration), speech: "",
        visual: scene.edit.detail ?? scene.visualDescription, cutReason: scene.edit.cutReason, audioFrom: lastAroll?.id ?? null });
    }
  }
  return items;
}
