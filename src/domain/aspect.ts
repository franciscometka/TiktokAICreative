/**
 * Proporções (puro). Usado para evitar o CROP do centro que modelos image-to-video aplicam quando
 * a foto não tem a proporção pedida (docs oficiais da Runway, "auto-cropping of inputs").
 */

export function ratioAspect(ratio: string): number {
  const [w, h] = ratio.split(":").map(Number);
  if (!w || !h) throw new Error(`Proporção inválida: ${ratio}`);
  return w / h;
}

/** Fração da imagem que se PERDE ao cortá-la do centro para a proporção alvo (0 = nada). */
export function centerCropLoss(imageAspect: number, targetAspect: number): number {
  return imageAspect > targetAspect ? 1 - targetAspect / imageAspect : 1 - imageAspect / targetAspect;
}

/** Perda máxima tolerada quando o produto precisa aparecer inteiro (bordas finas apenas). */
export const MAX_FULL_PRODUCT_CROP = 0.08;
/** Perda tolerada para preencher a tela 9:16 em cenas de contexto. */
export const MAX_CONTEXT_CROP = 0.3;

/**
 * Proporção a pedir ao modelo. 9:16 (primeira da lista) quando o corte for pequeno; senão a
 * proporção aceita que MENOS corta a foto — o render depois encaixa o clipe inteiro (contain) no
 * quadro 9:16. `full_product` é estrito (preserva o produto inteiro); contexto tolera mais corte.
 */
export function pickOutputRatio(
  ratios: readonly string[],
  imageAspect: number | undefined,
  framing: "full_product" | "product_detail" | "in_context" | "person_medium",
): { ratio: string; cropLoss: number } {
  const vertical = ratios[0];
  if (!vertical) throw new Error("Modelo sem proporções configuradas");
  if (imageAspect === undefined || !(imageAspect > 0)) return { ratio: vertical, cropLoss: 0 };
  const loss = (r: string) => centerCropLoss(imageAspect, ratioAspect(r));
  const tolerance = framing === "full_product" ? MAX_FULL_PRODUCT_CROP : framing === "product_detail" ? 1 : MAX_CONTEXT_CROP;
  if (loss(vertical) <= tolerance) return { ratio: vertical, cropLoss: loss(vertical) };
  const best = [...ratios].sort((a, b) => loss(a) - loss(b))[0] ?? vertical;
  return { ratio: best, cropLoss: loss(best) };
}
