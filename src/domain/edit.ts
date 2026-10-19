import { z } from "zod";

/**
 * Creative Editor V2 (Lote 5.6). O AI UGC é editado como UMA narrativa contínua, não como
 * concatenação de cenas independentes:
 *   - A-ROLL: a apresentadora falando (rosto + produto). É a ESPINHA de áudio do vídeo.
 *   - B-ROLL: detalhe contextual (mão, botão, bico, produto girando, mesma bancada) que entra
 *     VISUALMENTE por cima do áudio do A-roll. Nunca toca áudio próprio.
 * Este arquivo só define os modelos; as regras puras ficam em `ai/ugc-editorial.ts` (plano) e
 * `render/edit-plan.ts` (edição final). Nada aqui conhece provider ou Remotion.
 */

const nonEmpty = z.string().trim().min(1);

export const EDIT_PLAN_VERSION = 2 as const;

export const EDIT_ROLES = ["aroll", "broll"] as const;
export const EditRoleSchema = z.enum(EDIT_ROLES);
export type EditRole = z.infer<typeof EditRoleSchema>;

/**
 * Todo corte tem um motivo. `opening` marca o primeiro trecho (não é corte). Cortar "porque a
 * cena acabou" não existe: sem motivo, o A-roll continua.
 */
export const CUT_REASONS = [
  "opening",
  "sentence_boundary",
  "action_match",
  "product_reveal",
  "detail_emphasis",
  "hand_occlusion",
  "camera_motion",
  "hook_emphasis",
  "cta_return",
] as const;
export const CutReasonSchema = z.enum(CUT_REASONS);
export type CutReason = z.infer<typeof CutReasonSchema>;

/** Transições discretas. `crossfade` é exceção e só existe quando o plano pede explicitamente. */
export const EDIT_TRANSITIONS = ["straight_cut", "match_cut", "cut_on_action", "object_wipe", "punch_in", "crossfade"] as const;
export const EditTransitionSchema = z.enum(EDIT_TRANSITIONS);
export type EditTransition = z.infer<typeof EditTransitionSchema>;

/**
 * Tipos de B-roll.
 * - reference_detail: recorte do FRAME de referência aprovado (mesma pessoa/ambiente/produto); custo zero.
 * - generated_context: clipe gerado contextual (mão no produto, mesma bancada); áudio sempre mudo.
 * - product_photo: foto de catálogo. PROIBIDA no UGC normal (só com estilo comercial explícito).
 */
export const BROLL_KINDS = ["reference_detail", "generated_context", "product_photo"] as const;
export const BrollKindSchema = z.enum(BROLL_KINDS);
export type BrollKind = z.infer<typeof BrollKindSchema>;

/**
 * Continuidade aproximada (não é medição): diz ao PRÓXIMO prompt como a cena anterior termina,
 * para o produto não "pular de mão" nem a câmera mudar sem motivo.
 */
export const SceneContinuitySchema = z.object({
  continuityGroup: nonEmpty,
  presenterPosition: z.enum(["center", "left_third", "right_third"]),
  productPosition: z.enum(["chest", "near_face", "waist", "table", "in_hand_close"]),
  productHand: z.enum(["right", "left", "both", "none"]),
  cameraPosition: z.enum(["front_eye_level", "front_slightly_high", "front_slightly_low", "over_shoulder", "top_down"]),
  cameraDistance: z.enum(["close_up", "medium_close", "medium", "macro"]),
  motionDirection: z.enum(["none", "toward_camera", "away_from_camera", "upward", "downward", "rotate"]),
  entryPose: nonEmpty,
  exitPose: nonEmpty,
  eyeDirection: z.enum(["camera", "product", "camera_then_product", "product_then_camera"]),
  environmentRevision: z.int().positive(),
  outfitRevision: z.int().positive(),
  identityRevision: z.int().positive(),
});
export type SceneContinuity = z.infer<typeof SceneContinuitySchema>;

/** Recorte do frame de referência para o B-roll `reference_detail` (frações 0–1 da imagem). */
export const DetailCropSchema = z.object({
  focusX: z.number().min(0).max(1),
  focusY: z.number().min(0).max(1),
  /** Escala inicial e final (push-in lento). Ex.: 1.8 → 1.95. */
  scaleFrom: z.number().min(1).max(3),
  scaleTo: z.number().min(1).max(3),
});
export type DetailCrop = z.infer<typeof DetailCropSchema>;

/**
 * Metadado editorial da cena (só no plano hidratado; o LLM não precisa produzir). `overlay=true`
 * = o trecho é visual por cima do áudio do A-roll e NÃO soma na duração do criativo.
 */
export const SceneEditSchema = z.object({
  version: z.literal(EDIT_PLAN_VERSION),
  role: EditRoleSchema,
  overlay: z.boolean(),
  cutReason: CutReasonSchema,
  transition: EditTransitionSchema,
  continuityGroup: nonEmpty,
  continuity: SceneContinuitySchema.optional(),
  brollKind: BrollKindSchema.optional(),
  crop: DetailCropSchema.optional(),
  /** Rótulo curto do que o B-roll mostra (ex.: "close nos botões"). */
  detail: z.string().max(120).optional(),
}).superRefine((edit, ctx) => {
  if (edit.role === "broll" && !edit.overlay) ctx.addIssue({ code: "custom", path: ["overlay"], message: "B-roll é sempre overlay sobre o áudio do A-roll." });
  if (edit.role === "aroll" && edit.overlay) ctx.addIssue({ code: "custom", path: ["overlay"], message: "A-roll é a espinha do vídeo, nunca overlay." });
  if (edit.role === "broll" && !edit.brollKind) ctx.addIssue({ code: "custom", path: ["brollKind"], message: "B-roll precisa declarar o tipo." });
});
export type SceneEdit = z.infer<typeof SceneEditSchema>;

// ---------- Edição final (gerada no render) ----------

/** Janela usada de um clipe gerado. Billing usa a duração GERADA; a edição só escolhe a janela. */
const window = { sourceInSeconds: z.number().nonnegative(), sourceOutSeconds: z.number().positive() };

export const EditVisualSegmentSchema = z.object({
  id: nonEmpty,
  startSeconds: z.number().nonnegative(),
  endSeconds: z.number().positive(),
  role: EditRoleSchema,
  sceneId: nonEmpty,
  media: z.enum(["video", "image"]),
  /** URI autorizada (outputs/...) ou mock://. */
  uri: nonEmpty,
  ...window,
  /** Visual SEMPRE mudo: o áudio vem só das faixas de áudio do plano. */
  muted: z.literal(true),
  cutReason: CutReasonSchema,
  transition: EditTransitionSchema,
  continuityGroup: nonEmpty,
  /** punch-in sutil (1.0–1.12) para disfarçar junção entre clipes do mesmo enquadramento. */
  scale: z.number().min(1).max(1.12).default(1),
  crop: DetailCropSchema.optional(),
  /** De qual A-roll vem o áudio enquanto este visual está na tela. */
  audioSceneId: nonEmpty,
}).refine(s => s.endSeconds > s.startSeconds && s.sourceOutSeconds > s.sourceInSeconds, { message: "Trecho com duração inválida." });
export type EditVisualSegment = z.infer<typeof EditVisualSegmentSchema>;

export const EditAudioTrackSchema = z.object({
  sceneId: nonEmpty,
  uri: nonEmpty,
  startSeconds: z.number().nonnegative(),
  endSeconds: z.number().positive(),
  ...window,
  /** Ganho linear por clipe (1 = original). Normalização conservadora: só quando há medida. */
  gain: z.number().min(0.25).max(2).default(1),
  /** Micro fades (s) para evitar click/pop no corte; nunca longos a ponto de "engolir" palavra. */
  fadeInSeconds: z.number().min(0).max(0.25),
  fadeOutSeconds: z.number().min(0).max(0.25),
});
export type EditAudioTrack = z.infer<typeof EditAudioTrackSchema>;

export const EditCaptionSchema = z.object({
  text: nonEmpty,
  startSeconds: z.number().nonnegative(),
  endSeconds: z.number().positive(),
  sceneId: nonEmpty,
  /** Poucos termos destacados (números/especificações informadas). */
  emphasis: z.array(nonEmpty).max(2).default([]),
});
export type EditCaption = z.infer<typeof EditCaptionSchema>;

/** Uso de cada clipe gerado: quanto foi pago × quanto entrou no corte final. */
export const ClipUsageSchema = z.object({
  sceneId: nonEmpty,
  role: EditRoleSchema,
  generatedSeconds: z.number().nonnegative(),
  usedSeconds: z.number().nonnegative(),
});
export type ClipUsage = z.infer<typeof ClipUsageSchema>;

export const EditPlanSchema = z.object({
  version: z.literal(EDIT_PLAN_VERSION),
  durationSeconds: z.number().positive(),
  visuals: z.array(EditVisualSegmentSchema).min(1),
  audio: z.array(EditAudioTrackSchema),
  captions: z.array(EditCaptionSchema),
  /** Texto de hook DELIBERADO, separado da legenda falada (ausente quando repetiria a fala). */
  hook: z.object({ text: nonEmpty, endSeconds: z.number().positive() }).optional(),
  /** CTA pequeno por cima da apresentadora (nunca card final que substitui o fundo). */
  cta: z.object({ text: nonEmpty, startSeconds: z.number().nonnegative(), endSeconds: z.number().positive(), overPresenter: z.boolean() }).optional(),
  usage: z.array(ClipUsageSchema),
});
export type EditPlan = z.infer<typeof EditPlanSchema>;

export class EditPlanError extends Error {
  override name = "EditPlanError";
}

const EPS = 1e-6;

/**
 * Invariantes do Edit Plan (puras): visuais contíguos cobrindo o vídeo inteiro, todo trecho com
 * motivo de corte, nenhum áudio sobreposto (nunca duas vozes), B-roll nunca fonte de áudio e
 * nenhuma janela usada maior que o clipe.
 */
export function assertValidEditPlan(plan: EditPlan): EditPlan {
  const parsed = EditPlanSchema.parse(plan);
  let cursor = 0;
  for (const [index, segment] of parsed.visuals.entries()) {
    if (Math.abs(segment.startSeconds - cursor) > EPS) throw new EditPlanError(`Trecho ${index + 1} não começa onde o anterior termina (buraco ou sobreposição).`);
    if (index === 0 && segment.cutReason !== "opening") throw new EditPlanError("O primeiro trecho é a abertura (cutReason=opening).");
    if (index > 0 && segment.cutReason === "opening") throw new EditPlanError(`Trecho ${index + 1}: todo corte precisa de motivo editorial.`);
    cursor = segment.endSeconds;
  }
  if (Math.abs(cursor - parsed.durationSeconds) > EPS) throw new EditPlanError("Os visuais não cobrem o vídeo inteiro.");
  const audio = [...parsed.audio].sort((a, b) => a.startSeconds - b.startSeconds);
  audio.forEach((track, i) => {
    const next = audio[i + 1];
    if (next && next.startSeconds < track.endSeconds - EPS) throw new EditPlanError("Áudio duplicado: duas faixas tocam ao mesmo tempo.");
    if (Math.abs((track.endSeconds - track.startSeconds) - (track.sourceOutSeconds - track.sourceInSeconds)) > 1e-3) throw new EditPlanError("Faixa de áudio com janela diferente do trecho na timeline.");
  });
  const brollScenes = new Set(parsed.visuals.filter(v => v.role === "broll").map(v => v.sceneId));
  if (parsed.audio.some(track => brollScenes.has(track.sceneId))) throw new EditPlanError("B-roll nunca é fonte de áudio.");
  return parsed;
}
