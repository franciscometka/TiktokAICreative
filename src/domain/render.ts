import { z } from "zod";
import { MotionSchema, ShotTypeSchema, TransitionSchema, VisualSourceSchema } from "./creative";

const nonEmpty = z.string().trim().min(1);
const seconds = z.number().nonnegative();

export const VIDEO_FORMAT = { width: 1080, height: 1920, fps: 30, container: "mp4" } as const;

/**
 * ESTRATÉGIA de composição de cada trecho (derivada de ScenePlan.visualSource, que continua sendo
 * a fonte da verdade e vai junto em `visualSource`). Só "generated_video" custa geração de IA;
 * os demais são montados pelo Remotion a partir de imagens/texto (custo de API zero).
 */
export const SceneAssetKindSchema = z.enum(["generated_video", "product_image", "text_card"]);
export type SceneAssetKind = z.infer<typeof SceneAssetKindSchema>;

export const ManifestAssetSchema = z.object({
  sceneId: nonEmpty,
  kind: SceneAssetKindSchema,
  /**
   * Arquivo local relativo (ex.: outputs/uploads/...) ou "mock://..." (asset simulado).
   * null = cena composta só com texto/fundo.
   */
  uri: z.string().nullable(),
  startSeconds: seconds,
  durationSeconds: z.number().positive(),
  motion: MotionSchema,
  shotType: ShotTypeSchema,
  transition: TransitionSchema.optional(),
  onScreenText: z.string(),
  /** Tipo visual pedido pelo plano (Lote 3+). Ausente em manifests antigos. */
  visualSource: VisualSourceSchema.optional(),
  /** Descrição da cena, usada só no placeholder em modo de desenvolvimento. */
  visualDescription: z.string().optional(),
});
export type ManifestAsset = z.infer<typeof ManifestAssetSchema>;

export const ManifestAudioSchema = z.object({
  kind: z.enum(["narration", "music"]),
  uri: nonEmpty,
  startSeconds: seconds,
  durationSeconds: seconds,
  /** true = áudio simulado (mock://): o renderer não inclui trilha. Ausente em manifests antigos. */
  isMock: z.boolean().optional(),
  /** Fim da última palavra (s), quando há timing real. */
  speechEndSeconds: seconds.optional(),
});
export type ManifestAudio = z.infer<typeof ManifestAudioSchema>;

export const ManifestCaptionSchema = z.object({
  text: nonEmpty,
  startSeconds: seconds,
  endSeconds: seconds,
});
export type ManifestCaption = z.infer<typeof ManifestCaptionSchema>;

export const RENDER_WARNING_CODES = [
  "generated_video_placeholder",
  "product_image_missing",
  "asset_not_provided",
  "asset_file_missing",
  "audio_unavailable",
  /** Narração real sem timing confiável: legendas estimadas (fallback do Lote 3). */
  "captions_estimated",
  /** Fala real mais longa que o plano: o fim do vídeo foi estendido (sem cortar fala). */
  "timeline_extended",
] as const;
export const RenderWarningCodeSchema = z.enum(RENDER_WARNING_CODES);
export type RenderWarningCode = z.infer<typeof RenderWarningCodeSchema>;

/** Situação esperada/tolerável (mock, asset ausente). Erro de segurança/corrupção NÃO vira warning. */
export const RenderWarningSchema = z.object({
  code: RenderWarningCodeSchema,
  sceneId: z.string().nullable(),
  message: nonEmpty,
});
export type RenderWarning = z.infer<typeof RenderWarningSchema>;

export const RenderManifestSchema = z.object({
  /** Ausente em manifests do Lote 2. */
  campaignId: z.string().optional(),
  creativeId: nonEmpty,
  assets: z.array(ManifestAssetSchema).min(1),
  audio: z.array(ManifestAudioSchema),
  captions: z.array(ManifestCaptionSchema),
  /** "alignment" = legendas com o tempo REAL da fala; "estimated" = distribuídas pela cena (Lote 3). */
  captionSource: z.enum(["alignment", "estimated"]).default("estimated"),
  /** Segundos acrescentados ao fim para a narração caber inteira (0 = duração do plano). */
  extendedSeconds: seconds.default(0),
  overlays: z.object({
    productName: nonEmpty,
    priceBrl: z.number().positive().optional(),
    callToAction: nonEmpty,
    /** Hook de abertura (headline). */
    hook: z.string().optional(),
    /** Benefício curto exibido junto do nome/preço no fim. */
    benefit: z.string().optional(),
  }),
  /** Duração final (s). Pode ser bem maior que os segundos de vídeo gerado por IA. */
  duration: z.number().positive(),
  generatedVideoSeconds: seconds,
  output: z.object({
    width: z.literal(VIDEO_FORMAT.width),
    height: z.literal(VIDEO_FORMAT.height),
    fps: z.literal(VIDEO_FORMAT.fps),
    container: z.literal(VIDEO_FORMAT.container),
    /** Pasta base das renderizações deste criativo (cada render cria uma versão dentro dela). */
    path: nonEmpty,
  }),
  /** Avisos conhecidos na montagem (ex.: cena de IA mock). */
  warnings: z.array(RenderWarningSchema).default([]),
});
export type RenderManifest = z.infer<typeof RenderManifestSchema>;

/** Uma execução de renderização de um criativo. Cada nova renderização é uma nova versão. */
export const RenderRecordSchema = z.object({
  id: nonEmpty,
  /** Versão no disco (ex.: "v2"); definida pelo renderer, que nunca sobrescreve outra versão. */
  renderId: z.string().optional(),
  status: z.enum(["rendering", "completed", "failed"]),
  renderer: nonEmpty,
  isMock: z.boolean(),
  startedAt: nonEmpty,
  finishedAt: z.string().optional(),
  outputUri: z.string().optional(),
  manifestUri: z.string().optional(),
  sizeBytes: z.int().nonnegative().optional(),
  durationSeconds: z.number().nonnegative().optional(),
  totalFrames: z.int().nonnegative().optional(),
  renderMs: z.number().nonnegative().optional(),
  warnings: z.array(RenderWarningSchema).default([]),
  error: z.string().optional(),
});
export type RenderRecord = z.infer<typeof RenderRecordSchema>;
