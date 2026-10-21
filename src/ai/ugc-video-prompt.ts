import type { ContinuityAction, SceneContinuity } from "@/domain/edit";
import type { UgcCharacterIdentity } from "@/domain/ugc";

/**
 * Prompt de vídeo AI UGC (Editor V2, Lote 5.6) — compartilhado por Veo direto (Google) e Veo via
 * Krea. PURO e determinístico. Objetivo: parecer um vídeo de celular gravado em casa, não um
 * comercial nem um avatar. Nenhum provider usado hoje aceita `negative_prompt` (Krea não expõe;
 * o contrato Google atual não envia), então as restrições vão como frases explícitas no texto.
 */

export const UGC_REALISM_LINES = [
  "Real smartphone video filmed at home for TikTok/Reels, vertical 9:16, handheld with subtle natural micro-movements.",
  "Natural domestic light, natural skin texture with pores, no beauty filter.",
  "Small posture changes, natural breathing, relaxed shoulders; expression varies naturally while talking.",
  "The person glances briefly at the product and back to the camera; gestures are slightly imperfect and not perfectly synchronized with the words.",
  // Lote 5.7 (Presenter Only): mais realismo de celular e continuidade entre trechos.
  "Phone camera look: slight handheld sway, tiny focus breathing, small natural imperfections; lighting consistent with the previous shots of the same room.",
  "Relaxed posture and natural hands (not perfect or exaggerated); the product is not always perfectly centered.",
  "Speech starts after a brief natural breath and ends on a complete sentence, followed by a short silent pause.",
] as const;

export const UGC_AVOID_LINES = [
  "Avoid: commercial studio look, corporate presenter or avatar look, constant smile, stiff catalog pose, perfectly locked camera, plastic or overly smooth skin, exaggeratedly perfect hands, robotic or over-synchronized movements, product perfectly centered the whole time.",
  "No on-screen text, captions, subtitles, logos, watermarks or graphic elements added to the video.",
] as const;

export interface UgcVideoPromptInput {
  action: string;
  speech: string;
  continuity?: Pick<SceneContinuity, "entryPose" | "exitPose" | "productHand" | "productPosition" | "cameraPosition" | "cameraDistance" | "motionDirection" | "eyeDirection" | "presenterPosition"> & Partial<Pick<SceneContinuity, "entryAction" | "exitAction">>;
  identity?: Pick<UgcCharacterIdentity, "appearance" | "wardrobe" | "environmentDescription" | "voiceDescription">;
  /** Linhas de fidelidade do produto (textos/números/logo não mudam). */
  fidelity?: readonly string[];
  /** Último trecho: depois da última palavra, ~1s de cena natural sem fala (nunca corta na sílaba). */
  finalTail?: boolean;
}

const sentence = (text: string) => {
  const t = text.trim().replace(/\s+/g, " ").replace(/[.\s]+$/, "");
  return t ? `${t[0]!.toUpperCase()}${t.slice(1)}.` : "";
};

/** Lote 6.2 (cut on action): ações físicas descritas para o modelo de vídeo. */
export const ACTION_TEXT: Record<ContinuityAction, string> = {
  raise_product: "raising the product slightly toward the camera",
  rotate_product: "slowly rotating the product in the hand",
  point_detail: "pointing at a detail of the product with the free hand",
  look_product_to_camera: "looking down at the product and back up to the camera",
  move_product_closer: "bringing the product a little closer to the camera",
  lower_product: "lowering the product slightly",
  shift_body: "a small natural shift of the body",
  hold_still: "holding the product still",
};

const EYES: Record<NonNullable<UgcVideoPromptInput["continuity"]>["eyeDirection"], string> = {
  camera: "Eyes mostly on the camera.",
  product: "Eyes mostly on the product.",
  camera_then_product: "Looks at the camera, then briefly at the product.",
  product_then_camera: "Looks at the product, then back at the camera.",
};

/** Ordem: realismo → continuidade (como começa/termina) → ação → identidade/produto → fala → evitar. */
export function buildUgcVideoPrompt(input: UgcVideoPromptInput): string {
  const c = input.continuity;
  const parts = [
    ...UGC_REALISM_LINES,
    c ? `Starts exactly where the previous shot ended: the person ${c.entryPose}, product in the ${c.productHand === "both" ? "both hands" : `${c.productHand} hand`} at ${c.productPosition.replaceAll("_", " ")}, camera ${c.cameraPosition.replaceAll("_", " ")} in ${c.cameraDistance.replaceAll("_", " ")} framing, person ${c.presenterPosition.replaceAll("_", " ")}, movement ${c.motionDirection.replaceAll("_", " ")}.` : "",
    // Lote 6.2: o início continua a ação em curso do trecho anterior (a junção cai no meio do movimento).
    c?.entryAction && c.entryAction !== "hold_still" ? `The shot opens already in motion, continuing the previous action: ${ACTION_TEXT[c.entryAction]}.` : "",
    sentence(input.action),
    c ? `Ends with the person: ${c.exitPose}.` : "",
    c?.exitAction && c.exitAction !== "hold_still" && !input.finalTail ? `In the last second the person starts ${ACTION_TEXT[c.exitAction]} and is still in the middle of that movement when the shot ends.` : "",
    c ? EYES[c.eyeDirection] : "",
    input.identity ? `Keep the same adult synthetic person (${input.identity.appearance}), wardrobe (${input.identity.wardrobe}) and environment (${input.identity.environmentDescription}) as the approved reference frame, and the exact same product.`
      : "Keep the same adult synthetic person, face, hair, wardrobe and environment as the approved reference frame, and the exact same product.",
    ...(input.fidelity ?? []),
    // Lote 6: fala nativa não trava a voz; a MESMA descrição em todos os trechos reduz a variação.
    input.identity?.voiceDescription ? `Voice: ${input.identity.voiceDescription}; exactly the same voice, accent, pitch and pace as in every other clip of this video.` : "",
    `The person says naturally in Brazilian Portuguese, casual and unhurried, with short pauses: "${input.speech.trim()}"`,
    input.finalTail ? "After the last word, the person stays in frame for about one second without speaking, with natural behavior (a small smile, a glance at the product, lowering the product slightly); never frozen, never cut right after the last syllable." : "",
    ...UGC_AVOID_LINES,
  ];
  return parts.filter(Boolean).join(" ");
}
