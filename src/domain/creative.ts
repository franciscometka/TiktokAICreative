import { z } from "zod";
import { EDIT_PLAN_VERSION, SceneEditSchema } from "./edit";

/**
 * Dois níveis de schema:
 * - *Draft*: formato que o LLM produz. Sem IDs — o modelo não deve inventar identificadores.
 * - Completo: Draft + IDs/ordem atribuídos pelo sistema (ver ai/hydrate.ts).
 * As regras de validação (refinements) são compartilhadas pelos dois níveis.
 */

const nonEmpty = z.string().trim().min(1);

/** Tolerância (s) entre a duração declarada do criativo e a soma das cenas. */
export const DURATION_TOLERANCE_SECONDS = 0.5;

export const CREATIVE_STYLES = [
  "ugc",
  "problem_solution",
  "review",
  "demonstration",
  "curiosity",
  "before_after",
] as const;
export const CreativeStyleSchema = z.enum(CREATIVE_STYLES);
export type CreativeStyle = z.infer<typeof CreativeStyleSchema>;

export const SHOT_TYPES = [
  "close_up",
  "medium",
  "wide",
  "product_detail",
  "pov",
  "hands",
  "talking_head",
  "text_card",
] as const;
export const ShotTypeSchema = z.enum(SHOT_TYPES);
export type ShotType = z.infer<typeof ShotTypeSchema>;

export const TRANSITIONS = ["cut", "fade", "slide", "zoom"] as const;
export const TransitionSchema = z.enum(TRANSITIONS);
export type Transition = z.infer<typeof TransitionSchema>;

/**
 * De onde vem o visual da cena (estratégia híbrida de custo).
 * Os tipos em GENERATED_VISUAL_SOURCES consomem geração; o resto é composto no Remotion.
 */
/** AI UGC (Lote 5.3): ugc_* = pessoa + produto a partir da referência aprovada; product_broll = close do produto. */
export const GENERATED_VISUAL_SOURCES = ["generated_video", "product_hero", "product_demo", "lifestyle", "presenter", "product_ugc", "ugc_hook", "ugc_demo", "ugc_benefit", "ugc_cta", "product_broll"] as const;
export const VISUAL_SOURCES = [
  ...GENERATED_VISUAL_SOURCES,
  "product_image",
  "text_card",
  "screenshot",
  "simple_background",
  "existing_asset",
  /** Editor V2 (AI UGC): B-roll recortado do FRAME de referência aprovado (custo zero). */
  "reference_detail",
] as const;
export const VisualSourceSchema = z.enum(VISUAL_SOURCES);
export type VisualSource = z.infer<typeof VisualSourceSchema>;

export type GeneratedVisualSource = (typeof GENERATED_VISUAL_SOURCES)[number];
/** Única regra canônica para decidir se uma fonte visual exige geração paga de vídeo. */
export function requiresGeneratedVideoForVisualSource(source: VisualSource): boolean {
  return (GENERATED_VISUAL_SOURCES as readonly VisualSource[]).includes(source);
}

export function isGeneratedSource(source: VisualSource): source is GeneratedVisualSource {
  return requiresGeneratedVideoForVisualSource(source);
}
export const VideoDirectionSchema = z.object({
  framing: z.enum(["full_product", "product_detail", "in_context", "person_medium"]),
  camera: z.enum(["locked", "lateral_slide", "slow_dolly_in", "slow_dolly_out", "orbit_arc", "handheld", "pan", "tilt"]),
  subjectAction: z.string().max(300), ambientMotion: z.string().max(300),
  pacing: z.enum(["calm", "steady", "energetic"]),
});
export type VideoDirection = z.infer<typeof VideoDirectionSchema>;
export type CameraMove = VideoDirection["camera"];

/** Movimento aplicado a visuais estáticos para não parecer slideshow. */
export const MOTIONS = ["none", "ken_burns", "pan", "zoom_in", "crop"] as const;
export const MotionSchema = z.enum(MOTIONS);
export type Motion = z.infer<typeof MotionSchema>;

// ---------- Concept ----------

const conceptShape = z.object({
  title: nonEmpty,
  angle: nonEmpty,
  hook: nonEmpty,
  targetEmotion: nonEmpty,
  format: CreativeStyleSchema,
  description: nonEmpty,
});

export const CreativeConceptDraftSchema = conceptShape;
export type CreativeConceptDraft = z.infer<typeof CreativeConceptDraftSchema>;

export const CreativeConceptSchema = conceptShape.extend({ id: nonEmpty });
export type CreativeConcept = z.infer<typeof CreativeConceptSchema>;

// ---------- Scene ----------

const sceneShape = z.object({
  duration: z.number().positive().max(60),
  narration: z.string(),
  onScreenText: z.string(),
  visualDescription: nonEmpty,
  /** Prompt para o provider de vídeo. Vazio quando a cena não usa vídeo gerado. */
  generationPrompt: z.string(),
  videoDirection: VideoDirectionSchema.optional(),
  shotType: ShotTypeSchema,
  transition: TransitionSchema.optional(),
  visualSource: VisualSourceSchema,
  motion: MotionSchema,
  requiresGeneratedVideo: z.boolean(),
  estimatedGenerationSeconds: z.number().nonnegative(),
});

type SceneLike = z.infer<typeof sceneShape>;

function checkSceneRules(scene: SceneLike, ctx: z.RefinementCtx): void {
  if (scene.requiresGeneratedVideo !== requiresGeneratedVideoForVisualSource(scene.visualSource)) {
    ctx.addIssue({
      code: "custom",
      path: ["visualSource"],
      message: 'requiresGeneratedVideo deve ser true se e somente se visualSource for um tipo gerado',
    });
  }
  if (scene.requiresGeneratedVideo) {
    if (scene.estimatedGenerationSeconds <= 0) {
      ctx.addIssue({
        code: "custom",
        path: ["estimatedGenerationSeconds"],
        message: "Cena com vídeo gerado precisa de estimatedGenerationSeconds > 0",
      });
    }
    if (scene.estimatedGenerationSeconds > scene.duration) {
      ctx.addIssue({
        code: "custom",
        path: ["estimatedGenerationSeconds"],
        message: "estimatedGenerationSeconds não pode exceder a duração da cena",
      });
    }
    if (scene.generationPrompt.trim().length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["generationPrompt"],
        message: "Cena com vídeo gerado precisa de generationPrompt",
      });
    }
  } else if (scene.estimatedGenerationSeconds !== 0) {
    ctx.addIssue({
      code: "custom",
      path: ["estimatedGenerationSeconds"],
      message: "Cena sem vídeo gerado deve ter estimatedGenerationSeconds = 0",
    });
  }
}

export const ScenePlanDraftSchema = sceneShape.superRefine(checkSceneRules);
export type ScenePlanDraft = z.infer<typeof ScenePlanDraftSchema>;

export const ScenePlanSchema = sceneShape
  /** Editor V2: papel A-roll/B-roll, motivo do corte e continuidade (ausente em planos antigos). */
  .extend({ id: nonEmpty, order: z.int().nonnegative(), edit: SceneEditSchema.optional() })
  .superRefine(checkSceneRules);
export type ScenePlan = z.infer<typeof ScenePlanSchema>;

// ---------- Creative ----------

function checkDurationsMatch(
  creative: { duration: number; scenes: { duration: number; edit?: { overlay: boolean } }[] },
  ctx: z.RefinementCtx,
): void {
  // B-roll overlay (Editor V2) fica por cima do áudio do A-roll e não soma na duração.
  const total = creative.scenes.filter((s) => !s.edit?.overlay).reduce((sum, s) => sum + s.duration, 0);
  if (Math.abs(total - creative.duration) > DURATION_TOLERANCE_SECONDS) {
    ctx.addIssue({
      code: "custom",
      path: ["scenes"],
      message: `Soma das cenas (${total}s) difere da duração do criativo (${creative.duration}s)`,
    });
  }
}

const creativeDraftShape = z.object({
  concept: CreativeConceptDraftSchema,
  /** Duração final do vídeo (s), incluindo trechos sem IA. */
  duration: z.number().positive().max(180),
  hook: nonEmpty,
  script: nonEmpty,
  scenes: z.array(ScenePlanDraftSchema).min(1),
  callToAction: nonEmpty,
});

export const CreativePlanDraftSchema = creativeDraftShape.superRefine(checkDurationsMatch);
export type CreativePlanDraft = z.infer<typeof CreativePlanDraftSchema>;

export const CreativePlanSchema = z
  .object({
    id: nonEmpty,
    productId: nonEmpty,
    concept: CreativeConceptSchema,
    duration: z.number().positive().max(180),
    hook: nonEmpty,
    script: nonEmpty,
    scenes: z.array(ScenePlanSchema).min(1),
    callToAction: nonEmpty,
    /** 2 = Creative Editor V2 (A-roll contínuo + B-roll overlay). Ausente = montagem linear antiga. */
    editPlanVersion: z.literal(EDIT_PLAN_VERSION).optional(),
  })
  .superRefine((creative, ctx) => {
    checkDurationsMatch(creative, ctx);
    creative.scenes.forEach((scene, index) => {
      if (scene.order !== index) {
        ctx.addIssue({
          code: "custom",
          path: ["scenes", index, "order"],
          message: "Cenas devem estar ordenadas sequencialmente a partir de 0",
        });
      }
    });
  });
export type CreativePlan = z.infer<typeof CreativePlanSchema>;

// ---------- Regras puras ----------

export function generatedVideoSeconds(plan: Pick<CreativePlan, "scenes">): number {
  return plan.scenes
    .filter((s) => s.requiresGeneratedVideo)
    .reduce((sum, s) => sum + s.estimatedGenerationSeconds, 0);
}

export function narrationCharacters(plan: Pick<CreativePlan, "scenes">): number {
  return plan.scenes.reduce((sum, s) => sum + s.narration.length, 0);
}
