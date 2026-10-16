import { z } from "zod";

export const GENERATION_QUALITIES = ["economy", "high", "premium", "custom"] as const;
export const GenerationQualitySchema = z.enum(GENERATION_QUALITIES);
export type GenerationQuality = z.infer<typeof GenerationQualitySchema>;

export const RangeSchema = z
  .object({ min: z.number().nonnegative(), max: z.number().nonnegative() })
  .refine((r) => r.min <= r.max, { message: "min deve ser <= max" });
export type Range = z.infer<typeof RangeSchema>;

/** Referência a uma entrada do catálogo de preços. */
export const PricingRefSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
});
export type PricingRef = z.infer<typeof PricingRefSchema>;

export const LLM_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const LlmEffortSchema = z.enum(LLM_EFFORTS);
export type LlmEffort = z.infer<typeof LlmEffortSchema>;

/** Modelo LLM + esforço para uma tarefa. O provider/model também é a chave de preço no catálogo. */
export const LlmChoiceSchema = PricingRefSchema.extend({ effort: LlmEffortSchema });
export type LlmChoice = z.infer<typeof LlmChoiceSchema>;

/**
 * Configuração resolvida de um nível de qualidade.
 * Os presets economy/high/premium são PONTOS DE PARTIDA configuráveis (config/quality-presets.ts),
 * não verdades absolutas. "custom" usa o mesmo schema com valores do usuário.
 */
export const QualitySettingsSchema = z.object({
  quality: GenerationQualitySchema,
  label: z.string().min(1),
  description: z.string().min(1),
  video: PricingRefSchema,
  audio: PricingRefSchema,
  /** Modelo usado no planejamento da campanha. */
  llm: LlmChoiceSchema,
  rendering: PricingRefSchema,
  /** AI UGC (Lote 5.3): referência pessoa+produto e vídeo UGC. Ausente fora desse modo. */
  ugc: z.object({ reference: PricingRefSchema, video: PricingRefSchema }).optional(),
  generatedVideoSeconds: RangeSchema,
  finalVideoSeconds: RangeSchema,
  /** Meta de custo de referência. Ausente em "custom". */
  targetCostBrl: RangeSchema.optional(),
  /** Tokens de planejamento atribuídos a cada criativo (rateio do planejamento da campanha). */
  llmTokensPerCreative: z.object({
    input: z.int().nonnegative(),
    output: z.int().nonnegative(),
  }),
  /** Usado para estimar narração antes do roteiro existir. */
  narrationCharsPerSecond: z.number().positive(),
});
export type QualitySettings = z.infer<typeof QualitySettingsSchema>;
