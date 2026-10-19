import type { SceneContinuity } from "@/domain/edit";

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
] as const;

export const UGC_AVOID_LINES = [
  "Avoid: commercial studio look, presenter or avatar look, constant smile, stiff catalog pose, perfectly locked camera, overly smooth skin, robotic or over-synchronized movements, product perfectly centered the whole time.",
  "No on-screen text, captions, subtitles, logos, watermarks or graphic elements added to the video.",
] as const;

export interface UgcVideoPromptInput {
  action: string;
  speech: string;
  continuity?: Pick<SceneContinuity, "entryPose" | "exitPose" | "productHand" | "productPosition" | "cameraDistance" | "eyeDirection" | "presenterPosition">;
  /** Linhas de fidelidade do produto (textos/números/logo não mudam). */
  fidelity?: readonly string[];
}

const sentence = (text: string) => {
  const t = text.trim().replace(/\s+/g, " ").replace(/[.\s]+$/, "");
  return t ? `${t[0]!.toUpperCase()}${t.slice(1)}.` : "";
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
    c ? `Starts exactly where the previous shot ended: the person ${c.entryPose}, product in the ${c.productHand === "both" ? "both hands" : `${c.productHand} hand`}, ${c.cameraDistance.replace("_", " ")} framing, person ${c.presenterPosition.replace("_", " ")}.` : "",
    sentence(input.action),
    c ? `Ends with the person: ${c.exitPose}.` : "",
    c ? EYES[c.eyeDirection] : "",
    "Keep the same adult synthetic person, face, hair, wardrobe and environment as the approved reference frame, and the exact same product.",
    ...(input.fidelity ?? []),
    `The person says naturally in Brazilian Portuguese, casual and unhurried, with short pauses: "${input.speech.trim()}"`,
    ...UGC_AVOID_LINES,
  ];
  return parts.filter(Boolean).join(" ");
}
