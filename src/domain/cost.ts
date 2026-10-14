import { z } from "zod";
import { GenerationQualitySchema } from "./quality";

/**
 * Modelos de custo. Separação deliberada:
 * - CostEstimate (kind: "estimate"): previsão ANTES de gastar. Sempre rotulada como estimativa.
 * - GenerationCost (kind: "actual"): registro de custo efetivo de UMA chamada, append-only.
 */

const nonEmpty = z.string().trim().min(1);
const money = z.number().nonnegative();

export const PRICING_UNITS = [
  "per_second",
  "per_1000_characters",
  "per_1m_input_tokens",
  "per_1m_output_tokens",
  "per_1m_cache_write_tokens",
  "per_1m_cache_read_tokens",
  "per_generation",
] as const;
export const PricingUnitSchema = z.enum(PRICING_UNITS);
export type PricingUnit = z.infer<typeof PricingUnitSchema>;

export const ProviderPricingSchema = z.object({
  provider: nonEmpty,
  model: nonEmpty,
  unit: PricingUnitSchema,
  priceUsd: money,
  /** Data (YYYY-MM-DD) em que o preço foi verificado/definido. */
  updatedAt: z.iso.date(),
  /** true = valor provisório, ainda não verificado com o fornecedor. */
  isPlaceholder: z.boolean(),
  source: z.string().optional(),
});
export type ProviderPricing = z.infer<typeof ProviderPricingSchema>;

export const ExchangeRateSchema = z.object({
  base: z.literal("USD"),
  quote: z.literal("BRL"),
  rate: z.number().positive(),
  source: z.enum(["env", "default", "api"]),
  updatedAt: nonEmpty,
});
export type ExchangeRate = z.infer<typeof ExchangeRateSchema>;

export const MoneySchema = z.object({ usd: money, brl: money });
export type Money = z.infer<typeof MoneySchema>;

export const COST_CATEGORIES = ["llm", "video", "audio", "rendering"] as const;
export const CostCategorySchema = z.enum(COST_CATEGORIES);
export type CostCategory = z.infer<typeof CostCategorySchema>;

/** Fases de custo FUTURO (ainda não gasto). O custo já incorrido fica em CostEstimate.incurred. */
export const CostPhaseSchema = z.enum(["generation", "rendering"]);
export type CostPhase = z.infer<typeof CostPhaseSchema>;

/** Operação que originou um custo — usada no ledger e nos relatórios. */
export const COST_OPERATIONS = [
  "campaign_plan",
  "video_generation",
  "audio_generation",
  "render",
] as const;
export const CostOperationSchema = z.enum(COST_OPERATIONS);
export type CostOperation = z.infer<typeof CostOperationSchema>;

export const CostLineItemSchema = z.object({
  category: CostCategorySchema,
  phase: CostPhaseSchema,
  description: nonEmpty,
  provider: nonEmpty,
  model: nonEmpty,
  unit: PricingUnitSchema,
  quantity: money,
  unitPriceUsd: money,
  subtotalUsd: money,
  isPlaceholderPrice: z.boolean(),
  sceneId: z.string().optional(),
});
export type CostLineItem = z.infer<typeof CostLineItemSchema>;

/** Custo JÁ GASTO atribuído ao criativo (rateio do planejamento real). Cancelar não o desfaz. */
export const IncurredCostSchema = z.object({
  llmCost: MoneySchema,
  /** Registros do ledger que compõem o valor (rateados entre os criativos da campanha). */
  ledgerEntryIds: z.array(nonEmpty),
  /** Quantos criativos dividem o custo do planejamento. */
  sharedAmongCreatives: z.int().positive(),
  /** true se o planejamento foi simulado (mock). */
  simulated: z.boolean(),
});
export type IncurredCost = z.infer<typeof IncurredCostSchema>;

export const CostEstimateSchema = z.object({
  kind: z.literal("estimate"),
  id: nonEmpty,
  creativeId: nonEmpty,
  quality: GenerationQualitySchema,
  /** JÁ INCORRIDO (custo real, não estimado). */
  incurred: IncurredCostSchema,
  /** FUTURO ESTIMADO por categoria. */
  videoCost: MoneySchema,
  audioCost: MoneySchema,
  renderingCost: MoneySchema,
  /** Soma do custo futuro estimado (o que a aprovação autoriza gastar). */
  estimatedAdditionalUsd: money,
  estimatedAdditionalBrl: money,
  /** incurred + futuro estimado. */
  projectedTotalUsd: money,
  projectedTotalBrl: money,
  exchangeRate: z.number().positive(),
  generatedVideoSeconds: money,
  finalVideoSeconds: money,
  breakdown: z.array(CostLineItemSchema),
  /** true se algum preço usado é provisório — a UI deve avisar. */
  containsPlaceholderPrices: z.boolean(),
  createdAt: nonEmpty,
});
export type CostEstimate = z.infer<typeof CostEstimateSchema>;

export const CostBudgetSchema = z.object({
  maxCostPerCreativeBrl: z.number().positive(),
  maxCostPerCampaignBrl: z.number().positive(),
  /**
   * Se o usuário PODE autorizar explicitamente exceder o limite.
   * Nunca significa "exceder automaticamente".
   */
  allowOverBudget: z.boolean(),
});
export type CostBudget = z.infer<typeof CostBudgetSchema>;

export const GenerationCostSchema = z.object({
  kind: z.literal("actual"),
  id: nonEmpty,
  campaignId: nonEmpty,
  /** null = custo de nível de campanha (ex.: planejamento com LLM). */
  jobId: z.string().nullable(),
  creativeId: z.string().nullable(),
  sceneId: z.string().nullable(),
  /** Liga o custo à tentativa de mídia (para saber se foi descartada). */
  attemptId: z.string().nullable(),
  /** Liga o custo à chamada de LLM registrada em LlmCallRecord. */
  llmCallId: z.string().nullable(),
  operation: CostOperationSchema,
  category: CostCategorySchema,
  description: nonEmpty,
  provider: nonEmpty,
  model: nonEmpty,
  unit: PricingUnitSchema,
  quantity: money,
  unitPriceUsd: money,
  costUsd: money,
  exchangeRate: z.number().positive(),
  costBrl: money,
  /** true = custo simulado por um mock; nenhum dinheiro foi gasto. */
  simulated: z.boolean(),
  createdAt: nonEmpty,
});
export type GenerationCost = z.infer<typeof GenerationCostSchema>;

export const BudgetScopeSchema = z.enum(["creative", "campaign"]);
export type BudgetScope = z.infer<typeof BudgetScopeSchema>;

export const BudgetExceededDecisionSchema = z.object({
  kind: z.literal("BUDGET_EXCEEDED"),
  scope: BudgetScopeSchema,
  currentCostBrl: money,
  additionalEstimatedCostBrl: money,
  newEstimatedTotalBrl: money,
  budgetBrl: money,
  /** Se a interface pode oferecer "Autorizar exceder limite" (além de "Cancelar"). */
  canAuthorizeOverBudget: z.boolean(),
});
export type BudgetExceededDecision = z.infer<typeof BudgetExceededDecisionSchema>;

/** Autorização humana explícita para exceder o limite até um teto específico. */
export const OverBudgetAuthorizationSchema = z.object({
  creativeUpToBrl: money.optional(),
  campaignUpToBrl: money.optional(),
  authorizedAt: nonEmpty,
});
export type OverBudgetAuthorization = z.infer<typeof OverBudgetAuthorizationSchema>;
