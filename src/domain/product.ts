import { z } from "zod";

const nonEmpty = z.string().trim().min(1);

export const ProductImageSchema = z.object({
  id: nonEmpty,
  /** URI local (outputs/...) ou remota. Nunca bytes inline no domínio. */
  uri: nonEmpty,
  alt: z.string().optional(),
});
export type ProductImage = z.infer<typeof ProductImageSchema>;

export const ProductInputSchema = z.object({
  id: nonEmpty,
  name: nonEmpty,
  url: z.url().optional(),
  description: nonEmpty,
  features: z.array(nonEmpty),
  benefits: z.array(nonEmpty),
  /** Preço de venda em BRL (exibido no criativo, não relacionado a custo de geração). */
  priceBrl: z.number().positive().optional(),
  targetAudience: z.string().trim().optional(),
  images: z.array(ProductImageSchema),
  notes: z.string().optional(),
});
export type ProductInput = z.infer<typeof ProductInputSchema>;
