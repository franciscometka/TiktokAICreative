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
/**
 * Lote 5.7 — Presenter Only: AI UGC padrão = só A-rolls da apresentadora, sem B-roll/imagem/card,
 * timeline quantizada em frames, cauda final natural e legenda mapeada às pausas medidas.
 * V2 continua lido/renderizável; B-roll segue disponível só com opt-in explícito.
 */
export const PRESENTER_EDIT_PLAN_VERSION = 3 as const;
export const EditPlanVersionSchema = z.union([z.literal(EDIT_PLAN_VERSION), z.literal(PRESENTER_EDIT_PLAN_VERSION)]);
export type EditPlanVersion = z.infer<typeof EditPlanVersionSchema>;

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
  "natural_pause",
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

/**
 * Transições discretas. `crossfade` é exceção e só existe quando o plano pede explicitamente.
 * Lote 6.2 — Natural Transition Engine (V3): `direct_match_cut`, `cut_on_action`, `micro_punch`,
 * `directional_motion_blur`, `micro_dissolve` (ordem de prioridade). Os antigos continuam válidos
 * para manifests já persistidos.
 */
export const NATURAL_TRANSITIONS = ["direct_match_cut", "cut_on_action", "micro_punch", "directional_motion_blur", "micro_dissolve"] as const;
export type NaturalTransition = (typeof NATURAL_TRANSITIONS)[number];
export const EDIT_TRANSITIONS = ["straight_cut", "match_cut", "cut_on_action", "object_wipe", "punch_in", "crossfade", "direct_match_cut", "micro_punch", "directional_motion_blur", "micro_dissolve"] as const;
export const EditTransitionSchema = z.enum(EDIT_TRANSITIONS);
export type EditTransition = z.infer<typeof EditTransitionSchema>;

/** Limites do engine (frames a 30 fps): nada chamativo, nada longo. */
export const TRANSITION_LIMITS = { maxFrames: 6, maxDissolveFrames: 4, maxBlendFrames: 4, blurFrames: { min: 2, max: 4 }, punchFrames: { min: 3, max: 6 }, maxPunchScale: 1.04 } as const;

/** Ações físicas que escondem a junção (cut on action): o fim de um trecho e o início do próximo compartilham uma delas. */
export const CONTINUITY_ACTIONS = ["raise_product", "rotate_product", "point_detail", "look_product_to_camera", "move_product_closer", "lower_product", "shift_body", "hold_still"] as const;
export const ContinuityActionSchema = z.enum(CONTINUITY_ACTIONS);
export type ContinuityAction = z.infer<typeof ContinuityActionSchema>;

/**
 * Transição escolhida para a ENTRADA de um trecho (Lote 6.2). `frames` = duração visual do efeito;
 * 0 = corte direto. Só visual: o áudio nunca é tocado pela transição.
 */
export const TransitionSpecSchema = z.object({
  type: z.enum(NATURAL_TRANSITIONS),
  frames: z.int().min(0).max(TRANSITION_LIMITS.maxFrames),
  /** Blend curtíssimo (match cut) ou dissolve: o trecho anterior continua por baixo por N frames. */
  blendFrames: z.int().min(0).max(TRANSITION_LIMITS.maxBlendFrames).default(0),
  punch: z.object({ fromScale: z.number().min(1).max(TRANSITION_LIMITS.maxPunchScale), toScale: z.number().min(1).max(TRANSITION_LIMITS.maxPunchScale) }).optional(),
  blurDirection: z.enum(["left", "right", "up", "down"]).optional(),
  /** Por que este tipo (auditoria/diagnóstico avançado). */
  reason: nonEmpty,
  /** Similaridade pose/framing (0–1) entre a saída do anterior e a entrada deste. */
  similarity: z.number().min(0).max(1),
}).superRefine((t, ctx) => {
  if (t.type === "micro_dissolve" && (t.blendFrames < 2 || t.blendFrames > TRANSITION_LIMITS.maxDissolveFrames)) ctx.addIssue({ code: "custom", message: "micro_dissolve: 2–4 frames." });
  if (t.type === "directional_motion_blur" && (t.frames < TRANSITION_LIMITS.blurFrames.min || t.frames > TRANSITION_LIMITS.blurFrames.max || !t.blurDirection)) ctx.addIssue({ code: "custom", message: "Motion blur: 2–4 frames com direção." });
  if (t.type === "micro_punch" && (!t.punch || t.frames < TRANSITION_LIMITS.punchFrames.min)) ctx.addIssue({ code: "custom", message: "Micro punch: 3–6 frames com escala." });
  if (t.blendFrames > t.frames && t.type !== "direct_match_cut") ctx.addIssue({ code: "custom", message: "Blend maior que a transição." });
});
export type TransitionSpec = z.infer<typeof TransitionSpecSchema>;

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
  /** Lote 6.2 (cut on action): ação em curso na entrada/saída; a entrada continua a saída anterior. */
  entryAction: ContinuityActionSchema.optional(),
  exitAction: ContinuityActionSchema.optional(),
  handPosition: z.enum(["right", "left", "both", "none"]).optional(),
  gazeDirection: z.enum(["camera", "product", "camera_then_product", "product_then_camera"]).optional(),
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

/** Intervalos medidos no áudio REAL pelo `silencedetect` local; não são timestamps de palavras. */
export const AudioSilenceIntervalSchema = z.object({
  startSeconds: z.number().nonnegative(),
  endSeconds: z.number().positive(),
}).refine(interval => interval.endSeconds > interval.startSeconds, { message: "Silêncio com duração inválida." });
export type AudioSilenceInterval = z.infer<typeof AudioSilenceIntervalSchema>;

export const AudioSilenceAnalysisSchema = z.object({
  source: z.literal("ffmpeg_silencedetect"),
  noiseDb: z.number().max(0),
  minSilenceSeconds: z.number().positive(),
  intervals: z.array(AudioSilenceIntervalSchema),
});
export type AudioSilenceAnalysis = z.infer<typeof AudioSilenceAnalysisSchema>;

/**
 * Metadado editorial da cena (só no plano hidratado; o LLM não precisa produzir). `overlay=true`
 * = o trecho é visual por cima do áudio do A-roll e NÃO soma na duração do criativo.
 */
export const SceneEditSchema = z.object({
  version: EditPlanVersionSchema,
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
  /** Presenter Only: último trecho (fechamento + CTA falado + cauda natural). */
  finalTail: z.boolean().optional(),
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
  /** Campo legado do primeiro V2; mantido para ler manifests já persistidos. */
  audioSceneId: nonEmpty.optional(),
  /** A-roll(s) cujo áudio continua enquanto este visual está na tela (L/J cut pode cobrir dois). */
  audioSceneIds: z.array(nonEmpty).min(1).optional(),
  /** V3: fala do trecho, pausas medidas (tempo do CLIPE) e cauda natural do último trecho. */
  speech: z.string().optional(),
  pauseBoundaries: z.array(AudioSilenceIntervalSchema).optional(),
  continuity: SceneContinuitySchema.optional(),
  finalTailSeconds: z.number().nonnegative().optional(),
  /** Lote 6.2: transição natural de ENTRADA deste trecho (ausente = corte seco; manifests antigos). */
  transitionSpec: TransitionSpecSchema.optional(),
}).superRefine((segment, ctx) => {
  if (!(segment.endSeconds > segment.startSeconds && segment.sourceOutSeconds > segment.sourceInSeconds)) {
    ctx.addIssue({ code: "custom", message: "Trecho com duração inválida." });
  }
  if (!segment.audioSceneId && !segment.audioSceneIds) {
    ctx.addIssue({ code: "custom", message: "Trecho sem fonte de áudio." });
  }
}).transform(({ audioSceneId, audioSceneIds, ...segment }) => ({
  ...segment,
  audioSceneId: audioSceneId ?? audioSceneIds![0]!,
  audioSceneIds: audioSceneIds ?? [audioSceneId!],
}));
export type EditVisualSegment = z.infer<typeof EditVisualSegmentSchema>;

export const EditAudioTrackSchema = z.object({
  sceneId: nonEmpty,
  uri: nonEmpty,
  startSeconds: z.number().nonnegative(),
  endSeconds: z.number().positive(),
  ...window,
  /** Ganho linear por clipe (1 = original). Normalização conservadora: só quando há medida. */
  gain: z.number().min(0.25).max(1).default(1),
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
  /**
   * Sem ASR: nunca word-level real. V2 = proporcional ao roteiro; V3 = frases do roteiro mapeadas
   * aos intervalos de FALA medidos (entre pausas), trocando de legenda preferencialmente na pausa.
   */
  timingSource: z.enum(["estimated_from_script", "mapped_to_audio_pauses"]).default("estimated_from_script"),
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
  version: EditPlanVersionSchema,
  /** V3: fps da quantização (todos os tempos são múltiplos de 1/fps). */
  fps: z.int().positive().optional(),
  /** V3: segundos de vídeo natural depois da última palavra (≥ minTail quando medido). */
  finalTailSeconds: z.number().nonnegative().optional(),
  /** V3: avisos editoriais verificáveis (ex.: duração abaixo da meta, cauda sem medição). */
  warnings: z.array(z.string()).optional(),
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

/** Fronteiras em que uma transição natural pode acontecer (nunca no meio de uma fala). */
export const VALID_TRANSITION_BOUNDARIES: readonly CutReason[] = ["sentence_boundary", "natural_pause", "action_match"];

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
    // Lote 6.2: transição natural só na junção, e só em fronteira válida (fim de frase, pausa medida, ação).
    if (segment.transitionSpec && index === 0) throw new EditPlanError("A abertura não tem transição.");
    if (segment.transitionSpec && !VALID_TRANSITION_BOUNDARIES.includes(segment.cutReason)) throw new EditPlanError(`Trecho ${index + 1}: transição fora de fronteira válida (${segment.cutReason}).`);
    cursor = segment.endSeconds;
  }
  if (Math.abs(cursor - parsed.durationSeconds) > EPS) throw new EditPlanError("Os visuais não cobrem o vídeo inteiro.");
  const audio = [...parsed.audio].sort((a, b) => a.startSeconds - b.startSeconds);
  let audioCursor = 0;
  audio.forEach((track, i) => {
    const next = audio[i + 1];
    if (Math.abs(track.startSeconds - audioCursor) > EPS) throw new EditPlanError("Áudio com lacuna ou sobreposição entre A-rolls.");
    if (next && next.startSeconds < track.endSeconds - EPS) throw new EditPlanError("Áudio duplicado: duas faixas tocam ao mesmo tempo.");
    if (Math.abs((track.endSeconds - track.startSeconds) - (track.sourceOutSeconds - track.sourceInSeconds)) > 1e-3) throw new EditPlanError("Faixa de áudio com janela diferente do trecho na timeline.");
    audioCursor = track.endSeconds;
  });
  if (audio.length > 0 && Math.abs(audioCursor - parsed.durationSeconds) > EPS) throw new EditPlanError("Áudio não cobre a duração inteira do Editor V2.");
  if (parsed.version === PRESENTER_EDIT_PLAN_VERSION) {
    // Presenter Only: 100% da duração visual é vídeo da apresentadora.
    const stray = parsed.visuals.find(visual => visual.role !== "aroll" || visual.media !== "video");
    if (stray) throw new EditPlanError("Presenter Only: nenhum B-roll, imagem estática ou card entra na timeline.");
    if (parsed.audio.length !== parsed.visuals.length) throw new EditPlanError("Presenter Only: uma faixa de áudio por trecho da apresentadora.");
    const fps = parsed.fps ?? 30;
    const offGrid = (x: number) => Math.abs(x * fps - Math.round(x * fps)) > 1e-3;
    if ([...parsed.visuals.flatMap(v => [v.startSeconds, v.endSeconds]), ...parsed.audio.flatMap(a => [a.startSeconds, a.endSeconds])].some(offGrid)) {
      throw new EditPlanError("Presenter Only: tempos fora da grade de frames (risco de travada por arredondamento).");
    }
  }
  const brollScenes = new Set(parsed.visuals.filter(v => v.role === "broll").map(v => v.sceneId));
  if (parsed.audio.some(track => brollScenes.has(track.sceneId))) throw new EditPlanError("B-roll nunca é fonte de áudio.");
  const audioSceneIds = new Set(audio.map(track => track.sceneId));
  for (const visual of parsed.visuals) {
    if (visual.audioSceneIds.some(sceneId => !audioSceneIds.has(sceneId))) throw new EditPlanError("Visual aponta para uma fonte de áudio inexistente.");
    if (visual.role === "aroll" && (visual.audioSceneIds.length !== 1 || visual.audioSceneIds[0] !== visual.sceneId)) throw new EditPlanError("A-roll precisa usar somente o próprio áudio.");
  }
  return parsed;
}
