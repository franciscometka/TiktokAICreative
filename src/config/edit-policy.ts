import type { CutReason, DetailCrop, SceneContinuity } from "@/domain/edit";
import type { UgcPersonSource } from "@/domain/ugc";
import type { PresetQuality } from "./quality-presets";

/**
 * Política editorial do Creative Editor V2 (Lote 5.6). Valores CONSERVADORES e centralizados;
 * a edição é determinística e testável. Nada aqui altera billing: segundos gerados continuam
 * cobrados; a edição só escolhe a janela usada de cada clipe.
 */
export const EDIT_POLICY = {
  /** Handles dos clipes IA: descartam estabilização inicial e frames estranhos do fim. */
  handles: {
    aroll: { headSeconds: 0.3, tailSeconds: 0.4 },
    broll: { headSeconds: 0.4, tailSeconds: 0.4 },
  },
  /** Se o clipe for curto demais para os handles, usa o clipe inteiro (nunca janela < isso). */
  minUsableSeconds: 1.5,
  /** Fração do B-roll de junção que cobre o FIM do A-roll anterior (L-cut); o resto já é o áudio do próximo (J-cut). */
  junctionTailShare: 0.6,
  /** A-roll sempre aparece pelo menos isso antes/depois de um B-roll (evita flicker). */
  minArollVisibleSeconds: 1.2,
  /** B-roll dentro dessa faixa (s) — mais curto vira flicker; mais longo vira "card". */
  broll: { minSeconds: 0.8, maxSeconds: 2.5 },
  /** Micro fades de áudio no corte (anti click/pop). Curtos para não engolir palavra. */
  audioFadeSeconds: 0.06,
  /** Punch-in sutil na junção direta entre dois A-rolls do mesmo enquadramento. */
  punchInScale: 1.06,
  /** CTA pequeno sobre a apresentadora no fim; nenhum B-roll entra nessa janela. */
  ctaSeconds: 1.8,
  ctaLabel: "Veja no carrinho",
  /** Hook textual deliberado (só quando não repete a fala). */
  hookMaxSeconds: 2.2,
  /** Legenda: no máximo 2 linhas; trechos curtos. */
  caption: { maxLines: 2, maxCharsPerLine: 26, maxEmphasis: 1 },
  /** Folga do roteiro: a fala planejada ocupa no máximo esta fração do tempo útil do A-roll. */
  speechFillRatio: 0.82,
} as const;

export interface ArollPlanEntry {
  role: "aroll";
  source: UgcPersonSource;
  seconds: number;
}

export interface BrollPlanEntry {
  role: "broll";
  kind: "reference_detail";
  seconds: number;
  cutReason: Extract<CutReason, "product_reveal" | "detail_emphasis" | "hand_occlusion" | "action_match">;
  detail: string;
  crop: DetailCrop;
}

export type EditorialPlanEntry = ArollPlanEntry | BrollPlanEntry;

const CROPS = {
  productInHand: { focusX: 0.5, focusY: 0.6, scaleFrom: 1.7, scaleTo: 1.82 },
  productDetail: { focusX: 0.52, focusY: 0.56, scaleFrom: 2.1, scaleTo: 2.24 },
  handsLow: { focusX: 0.5, focusY: 0.66, scaleFrom: 1.9, scaleTo: 2.02 },
} as const satisfies Record<string, DetailCrop>;

/**
 * Presets editoriais (A-roll = espinha de áudio; B-roll = overlay de junção, recortado do frame de
 * referência aprovado, custo zero). Duração final = soma dos A-rolls. Cada A-roll ≤ 8s (Veo).
 * Econômico 2 A + 1 B (15s) · Equilibrado 3 A + 2 B (22,5s) · Premium 4 A + 3 B (30s).
 */
export const UGC_EDITORIAL_PLANS: Record<PresetQuality, readonly EditorialPlanEntry[]> = {
  economy: [
    { role: "aroll", source: "ugc_hook", seconds: 7.5 },
    { role: "broll", kind: "reference_detail", seconds: 1.6, cutReason: "product_reveal", detail: "produto na mão, de perto", crop: CROPS.productInHand },
    { role: "aroll", source: "ugc_cta", seconds: 7.5 },
  ],
  high: [
    { role: "aroll", source: "ugc_hook", seconds: 7.5 },
    { role: "broll", kind: "reference_detail", seconds: 1.6, cutReason: "product_reveal", detail: "produto na mão, de perto", crop: CROPS.productInHand },
    { role: "aroll", source: "ugc_demo", seconds: 7.5 },
    { role: "broll", kind: "reference_detail", seconds: 1.5, cutReason: "detail_emphasis", detail: "close nos detalhes e botões", crop: CROPS.productDetail },
    { role: "aroll", source: "ugc_cta", seconds: 7.5 },
  ],
  premium: [
    { role: "aroll", source: "ugc_hook", seconds: 7.5 },
    { role: "broll", kind: "reference_detail", seconds: 1.6, cutReason: "product_reveal", detail: "produto na mão, de perto", crop: CROPS.productInHand },
    { role: "aroll", source: "ugc_demo", seconds: 7.5 },
    { role: "broll", kind: "reference_detail", seconds: 1.5, cutReason: "detail_emphasis", detail: "close nos detalhes e botões", crop: CROPS.productDetail },
    { role: "aroll", source: "ugc_benefit", seconds: 7.5 },
    { role: "broll", kind: "reference_detail", seconds: 1.4, cutReason: "hand_occlusion", detail: "mãos segurando o produto", crop: CROPS.handsLow },
    { role: "aroll", source: "ugc_cta", seconds: 7.5 },
  ],
};

export const DEFAULT_DETAIL_CROP: DetailCrop = CROPS.productInHand;

type ContinuityPose = Pick<SceneContinuity, "productPosition" | "motionDirection" | "exitPose" | "eyeDirection">;

/** Pose de SAÍDA de cada papel de A-roll; a entrada do próximo é a saída do anterior. */
export const AROLL_POSES: Record<UgcPersonSource, ContinuityPose> = {
  ugc_hook: { productPosition: "chest", motionDirection: "upward", eyeDirection: "camera", exitPose: "raises the product slightly from chest toward the camera" },
  ugc_demo: { productPosition: "chest", motionDirection: "rotate", eyeDirection: "product_then_camera", exitPose: "product turned a little to show its side, held at chest height" },
  ugc_benefit: { productPosition: "chest", motionDirection: "none", eyeDirection: "camera_then_product", exitPose: "points at one detail of the product with the free hand, product at chest height" },
  ugc_cta: { productPosition: "near_face", motionDirection: "toward_camera", eyeDirection: "camera", exitPose: "holds the product a bit closer to the camera, relaxed" },
};

export const AROLL_OPENING_POSE = "holds the product at chest height in the right hand, looking at the camera";
