import { z } from "zod";

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
 * Só "generated_video" consome geração paga; o resto é composto no Remotion.
 */
export const VISUAL_SOURCES = [
  "generated_video",
  "product_image",
  "text_card",
  "screenshot",
  "simple_background",
  "existing_asset",
] as const;
export const VisualSourceSchema = z.enum(VISUAL_SOURCES);
export type VisualSource = z.infer<typeof VisualSourceSchema>;

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
  shotType: ShotTypeSchema,
  transition: TransitionSchema.optional(),
  visualSource: VisualSourceSchema,
  motion: MotionSchema,
  requiresGeneratedVideo: z.boolean(),
  estimatedGenerationSeconds: z.number().nonnegative(),
});

type SceneLike = z.infer<typeof sceneShape>;

function checkSceneRules(scene: SceneLike, ctx: z.RefinementCtx): void {
  if (scene.requiresGeneratedVideo !== (scene.visualSource === "generated_video")) {
    ctx.addIssue({
      code: "custom",
      path: ["visualSource"],
      message: 'requiresGeneratedVideo deve ser true se e somente se visualSource = "generated_video"',
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
  .extend({ id: nonEmpty, order: z.int().nonnegative() })
  .superRefine(checkSceneRules);
export type ScenePlan = z.infer<typeof ScenePlanSchema>;

// ---------- Creative ----------

function checkDurationsMatch(
  creative: { duration: number; scenes: { duration: number }[] },
  ctx: z.RefinementCtx,
): void {
  const total = creative.scenes.reduce((sum, s) => sum + s.duration, 0);
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
