import { z } from "zod";
/** Prepared contract for /v1/recipes/product_ugc; no callable generation route yet. */
export const ProductUgcInputSchema = z.object({
  characterImage: z.object({ uri: z.string().min(1) }),
  imageConsent: z.literal(true, { error: "Exige autorização para usar a imagem da pessoa." }),
  productImage: z.object({ uri: z.string().min(1) }),
  productInfo: z.string().trim().min(1).max(5000), userConcept: z.string().trim().min(1).max(5000),
  duration: z.number().min(4).max(15),
});
export function prepareProductUgc(input: unknown) {
  const { imageConsent: _consent, ...data } = ProductUgcInputSchema.parse(input);
  void _consent;
  return { endpoint: "/v1/recipes/product_ugc", body: { ...data, version: "2026-06" as const, ratio: "720:1280" as const, audio: false as const } };
}
