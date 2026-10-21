import {
  TRANSITION_LIMITS,
  TransitionSpecSchema,
  type ContinuityAction,
  type SceneContinuity,
  type TransitionSpec,
} from "@/domain/edit";

/**
 * Lote 6.2 — Natural Transition Engine (PURO). Escolhe como o trecho N+1 entra depois do trecho N
 * para os A-rolls parecerem UM vídeo de TikTok editado, não clipes colados:
 *
 *   1. direct_match_cut        — saída de N ≈ entrada de N+1 (pose, mão, produto, olhar, framing)
 *   2. cut_on_action           — N termina e N+1 começa na MESMA ação física (girar, levantar…)
 *   3. micro_punch             — framing compatível, pose diferente: 100%→103,5% (ou volta) em 3–6 frames
 *   4. directional_motion_blur — há movimento compatível nos dois lados: blur direcional de 2–4 frames
 *   5. micro_dissolve          — último recurso, só com rosto/produto/ambiente alinhados: 2–4 frames
 *
 * Proibidos por construção: flash, spin, slide, 3D, wipe gráfico, crossfade longo (o schema não
 * tem esses tipos e limita tudo a ≤ 6 frames; dissolve ≤ 4). A transição é só VISUAL: o áudio dos
 * trechos continua contíguo e nunca é misturado sobre fala.
 */

export const TRANSITION_PRIORITY = ["direct_match_cut", "cut_on_action", "micro_punch", "directional_motion_blur", "micro_dissolve"] as const;

/** Ações que são MOVIMENTO (escondem a junção); `hold_still` não esconde nada. */
const MOVING_ACTIONS: readonly ContinuityAction[] = ["raise_product", "rotate_product", "point_detail", "look_product_to_camera", "move_product_closer", "lower_product", "shift_body"];

/** Lado da continuidade usado na comparação (saída de N ou entrada de N+1). */
export type ContinuitySide = Pick<SceneContinuity, "productPosition" | "productHand" | "eyeDirection" | "cameraDistance" | "presenterPosition" | "motionDirection" | "cameraPosition"> & {
  entryAction?: ContinuityAction;
  exitAction?: ContinuityAction;
};

/** Para onde o olhar termina/começa ("product_then_camera" termina na câmera). */
function gazeAtExit(eye: SceneContinuity["eyeDirection"]): "camera" | "product" {
  return eye === "product" || eye === "camera_then_product" ? "product" : "camera";
}
function gazeAtEntry(eye: SceneContinuity["eyeDirection"]): "camera" | "product" {
  return eye === "product" || eye === "product_then_camera" ? "product" : "camera";
}

/**
 * Similaridade 0–1 entre a SAÍDA do trecho anterior e a ENTRADA do próximo (metadados de
 * continuidade, não medição de pixels). Framing (câmera/distância/posição) pesa mais que pose.
 */
export function continuitySimilarity(previous: ContinuitySide, next: ContinuitySide): number {
  const checks: [boolean, number][] = [
    [previous.cameraPosition === next.cameraPosition, 0.15],
    [previous.cameraDistance === next.cameraDistance, 0.2],
    [previous.presenterPosition === next.presenterPosition, 0.15],
    [previous.productHand === next.productHand, 0.15],
    [previous.productPosition === next.productPosition, 0.15],
    [gazeAtExit(previous.eyeDirection) === gazeAtEntry(next.eyeDirection), 0.1],
    [(previous.exitAction ?? "hold_still") === (next.entryAction ?? "hold_still"), 0.1],
  ];
  return Math.round(checks.reduce((sum, [ok, weight]) => sum + (ok ? weight : 0), 0) * 100) / 100;
}

/** Framing compatível = mesma câmera, distância e posição da pessoa (sem isso, nada de blend). */
function framingMatches(previous: ContinuitySide, next: ContinuitySide): boolean {
  return previous.cameraPosition === next.cameraPosition && previous.cameraDistance === next.cameraDistance && previous.presenterPosition === next.presenterPosition;
}

const BLUR_DIRECTION: Partial<Record<SceneContinuity["motionDirection"], NonNullable<TransitionSpec["blurDirection"]>>> = {
  upward: "up", downward: "down", rotate: "right", toward_camera: "down", away_from_camera: "up",
};

export interface ChooseTransitionInput {
  previous?: ContinuitySide;
  next?: ContinuitySide;
  /** Escala em que o trecho anterior terminou (para o micro punch alternar 100% ↔ 103,5%). */
  previousScale: number;
  /** Frames de vídeo que sobram DEPOIS da saída do anterior (para blend/dissolve sem congelar). */
  previousSpareFrames: number;
}

const PUNCH_SCALE = 1.035;
const PUNCH_FRAMES = 4;

/** Escolha determinística da transição de ENTRADA do próximo trecho (ordem de prioridade fixa). */
export function chooseTransition(input: ChooseTransitionInput): TransitionSpec {
  const { previous, next } = input;
  const spare = Math.max(0, Math.floor(input.previousSpareFrames));
  const punch = (reason: string, similarity: number): TransitionSpec => {
    // Alterna: entra "apertado" depois de um trecho aberto e volta a 100% depois de um apertado.
    const zoomIn = input.previousScale <= 1 + 1e-6;
    return TransitionSpecSchema.parse({ type: "micro_punch", frames: PUNCH_FRAMES, blendFrames: 0, punch: zoomIn ? { fromScale: 1, toScale: PUNCH_SCALE } : { fromScale: PUNCH_SCALE, toScale: 1 }, reason, similarity });
  };
  // Sem metadados de continuidade (plano antigo): punch discreto é o mais seguro (nunca blend às cegas).
  if (!previous || !next) return punch("sem metadados de continuidade: punch discreto em vez de blend", 0);

  const similarity = continuitySimilarity(previous, next);
  const sharedAction = previous.exitAction && previous.exitAction === next.entryAction && MOVING_ACTIONS.includes(previous.exitAction) ? previous.exitAction : undefined;

  // 1) Match cut: pose/framing praticamente iguais → corte direto; quase iguais → blend de 2 frames (sem ghosting).
  if (similarity >= 0.9) {
    const blend = similarity < 1 && spare >= 2 ? 2 : 0;
    return TransitionSpecSchema.parse({ type: "direct_match_cut", frames: blend, blendFrames: blend, reason: blend ? "pose quase idêntica: blend de 2 frames" : "saída e entrada idênticas: corte direto", similarity });
  }
  // 2) Cut on action: a mesma ação física atravessa a junção → corte seco no meio do movimento.
  if (sharedAction && framingMatches(previous, next)) {
    return TransitionSpecSchema.parse({ type: "cut_on_action", frames: 0, blendFrames: 0, reason: `ação contínua: ${sharedAction}`, similarity });
  }
  // 3) Micro punch: framing compatível, pose diferente.
  if (framingMatches(previous, next) && similarity >= 0.6) return punch("framing compatível, pose diferente", similarity);
  // 4) Motion blur: movimento compatível dos dois lados (mesma direção).
  const direction = previous.motionDirection !== "none" && previous.motionDirection === next.motionDirection ? BLUR_DIRECTION[previous.motionDirection] : undefined;
  if (direction) return TransitionSpecSchema.parse({ type: "directional_motion_blur", frames: 3, blendFrames: 0, blurDirection: direction, reason: `movimento compatível (${previous.motionDirection})`, similarity });
  // 5) Dissolve curtíssimo: último recurso — enquadramento mudou um pouco, mas câmera, mão e posição do
  // produto batem (rosto/produto/ambiente alinhados o bastante para não duplicar mãos) e há vídeo sobrando.
  if (previous.cameraPosition === next.cameraPosition && previous.productHand === next.productHand && previous.productPosition === next.productPosition && spare >= 3) {
    return TransitionSpecSchema.parse({ type: "micro_dissolve", frames: 3, blendFrames: 3, reason: "alinhamento suficiente; nenhuma opção melhor", similarity });
  }
  return punch("sem alinhamento para blend: punch discreto", similarity);
}

/** Saída/entrada de continuidade a partir do metadado da cena (a entrada usa `entryAction`). */
export function continuitySide(continuity: SceneContinuity | undefined): ContinuitySide | undefined {
  if (!continuity) return undefined;
  const { productPosition, productHand, eyeDirection, cameraDistance, presenterPosition, motionDirection, cameraPosition, entryAction, exitAction } = continuity;
  return { productPosition, productHand, eyeDirection, cameraDistance, presenterPosition, motionDirection, cameraPosition, ...(entryAction ? { entryAction } : {}), ...(exitAction ? { exitAction } : {}) };
}

/** Rótulo curto para o diagnóstico avançado ("Trecho 2 → cut_on_action"). */
export const TRANSITION_LABELS: Record<TransitionSpec["type"], string> = {
  direct_match_cut: "match cut",
  cut_on_action: "corte na ação",
  micro_punch: "micro punch",
  directional_motion_blur: "motion blur curto",
  micro_dissolve: "micro dissolve",
};

export { TRANSITION_LIMITS };

/**
 * Prévia (antes do render) da transição de entrada de cada trecho, só a partir da continuidade
 * planejada; sem mídia não há blend (sobra de vídeo desconhecida). Para o diagnóstico avançado.
 */
export function plannedTransitions(scenes: readonly { id: string; edit?: { continuity?: SceneContinuity } }[]): Map<string, TransitionSpec["type"] | "opening"> {
  const out = new Map<string, TransitionSpec["type"] | "opening">();
  let scale = 1;
  scenes.forEach((scene, i) => {
    if (i === 0) { out.set(scene.id, "opening"); return; }
    const spec = chooseTransition({ previous: continuitySide(scenes[i - 1]!.edit?.continuity), next: continuitySide(scene.edit?.continuity), previousScale: scale, previousSpareFrames: 0 });
    scale = spec.punch ? spec.punch.toScale : scale;
    out.set(scene.id, spec.type);
  });
  return out;
}
