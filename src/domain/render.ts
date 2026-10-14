import { z } from "zod";
import { MotionSchema, ShotTypeSchema, TransitionSchema } from "./creative";

const nonEmpty = z.string().trim().min(1);
const seconds = z.number().nonnegative();

export const VIDEO_FORMAT = { width: 1080, height: 1920, fps: 30, container: "mp4" } as const;

/**
 * Como cada trecho é composto. Só "generated_video" custa geração de IA;
 * os demais são montados pelo Remotion a partir de imagens/texto (custo ~0).
 */
export const SceneAssetKindSchema = z.enum(["generated_video", "product_image", "text_card"]);
export type SceneAssetKind = z.infer<typeof SceneAssetKindSchema>;

export const ManifestAssetSchema = z.object({
  sceneId: nonEmpty,
  kind: SceneAssetKindSchema,
  uri: z.string().nullable(),
  startSeconds: seconds,
  durationSeconds: z.number().positive(),
  motion: MotionSchema,
  shotType: ShotTypeSchema,
  transition: TransitionSchema.optional(),
  onScreenText: z.string(),
});
export type ManifestAsset = z.infer<typeof ManifestAssetSchema>;

export const ManifestAudioSchema = z.object({
  kind: z.enum(["narration", "music"]),
  uri: nonEmpty,
  startSeconds: seconds,
  durationSeconds: seconds,
});
export type ManifestAudio = z.infer<typeof ManifestAudioSchema>;

export const ManifestCaptionSchema = z.object({
  text: nonEmpty,
  startSeconds: seconds,
  endSeconds: seconds,
});
export type ManifestCaption = z.infer<typeof ManifestCaptionSchema>;

export const RenderManifestSchema = z.object({
  creativeId: nonEmpty,
  assets: z.array(ManifestAssetSchema).min(1),
  audio: z.array(ManifestAudioSchema),
  captions: z.array(ManifestCaptionSchema),
  overlays: z.object({
    productName: nonEmpty,
    priceBrl: z.number().positive().optional(),
    callToAction: nonEmpty,
  }),
  /** Duração final (s). Pode ser bem maior que os segundos de vídeo gerado por IA. */
  duration: z.number().positive(),
  generatedVideoSeconds: seconds,
  output: z.object({
    width: z.literal(VIDEO_FORMAT.width),
    height: z.literal(VIDEO_FORMAT.height),
    fps: z.literal(VIDEO_FORMAT.fps),
    container: z.literal(VIDEO_FORMAT.container),
    path: nonEmpty,
  }),
});
export type RenderManifest = z.infer<typeof RenderManifestSchema>;
