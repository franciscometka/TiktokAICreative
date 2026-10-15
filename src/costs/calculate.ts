import type {
  CostCategory,
  CostEstimate,
  CostLineItem,
  CostOperation,
  CostPhase,
  GenerationCost,
  IncurredCost,
  Money,
  PricingUnit,
  ProviderPricing,
} from "@/domain/cost";
import { generatedVideoSeconds, type CreativePlan, type ScenePlan } from "@/domain/creative";
import { spokenNarrationCharacters } from "@/speech/narration-script";
import type { TokenUsage } from "@/domain/llm";
import type { PricingRef, QualitySettings } from "@/domain/quality";
import { roundBrl, roundUsd, usdToBrl } from "@/lib/money";
import { RUNWAY_VIDEO, runwayDuration } from "@/config/video-models";
import { RUNWAY_PRESENTER, presenterBilledSeconds } from "@/config/presenters";
import type { PricingCatalog } from "./pricing-catalog";

/**
 * Funções PURAS de cálculo de custo. Sem I/O, sem relógio, sem aleatoriedade.
 * Preços chegam como parâmetro (ProviderPricing) — nada de preço hardcoded aqui.
 */

export class UnsupportedUsageError extends Error {
  override name = "UnsupportedUsageError";
}

/** Consumo medido/estimado de uma chamada. Cada unidade de preço lê o campo correspondente. */
export interface Usage {
  seconds?: number;
  characters?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
  generations?: number;
}

const UNIT_DIVISOR: Record<PricingUnit, number> = {
  per_second: 1,
  per_1000_characters: 1_000,
  per_1m_input_tokens: 1_000_000,
  per_1m_output_tokens: 1_000_000,
  per_1m_cache_write_tokens: 1_000_000,
  per_1m_cache_read_tokens: 1_000_000,
  per_generation: 1,
};

/** Premissa para estimar preços "por geração" de vídeo antes do roteiro existir. */
export const ASSUMED_SECONDS_PER_GENERATED_CLIP = 5;

function requireField(value: number | undefined, unit: PricingUnit, field: keyof Usage): number {
  if (value === undefined) {
    throw new UnsupportedUsageError(`Unidade ${unit} exige usage.${field}`);
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new UnsupportedUsageError(`usage.${field} inválido: ${value}`);
  }
  return value;
}

/** Quantidade faturável de acordo com a unidade de preço. */
export function quantityFor(unit: PricingUnit, usage: Usage): number {
  switch (unit) {
    case "per_second":
      return requireField(usage.seconds, unit, "seconds");
    case "per_1000_characters":
      return requireField(usage.characters, unit, "characters");
    case "per_1m_input_tokens":
      return requireField(usage.inputTokens, unit, "inputTokens");
    case "per_1m_output_tokens":
      return requireField(usage.outputTokens, unit, "outputTokens");
    case "per_1m_cache_write_tokens":
      return requireField(usage.cacheWriteTokens, unit, "cacheWriteTokens");
    case "per_1m_cache_read_tokens":
      return requireField(usage.cacheReadTokens, unit, "cacheReadTokens");
    case "per_generation":
      return requireField(usage.generations ?? 1, unit, "generations");
  }
}

/** Custo em USD (sem arredondar) de `quantity` unidades. */
export function priceUnits(pricing: ProviderPricing, quantity: number): number {
  if (!Number.isFinite(quantity) || quantity < 0) {
    throw new RangeError(`Quantidade inválida: ${quantity}`);
  }
  return (quantity / UNIT_DIVISOR[pricing.unit]) * pricing.priceUsd;
}

export function costForUsage(pricing: ProviderPricing, usage: Usage): { quantity: number; costUsd: number } {
  const quantity = quantityFor(pricing.unit, usage);
  return { quantity, costUsd: priceUnits(pricing, quantity) };
}

export function toMoney(usd: number, exchangeRate: number): Money {
  return { usd: roundUsd(usd), brl: roundBrl(usdToBrl(usd, exchangeRate)) };
}

// ---------- LLM ----------

/** As quatro tarifas de um modelo LLM. */
export interface LlmPricing {
  input: ProviderPricing;
  output: ProviderPricing;
  cacheWrite: ProviderPricing;
  cacheRead: ProviderPricing;
}

export function resolveLlmPricing(ref: PricingRef, catalog: PricingCatalog): LlmPricing {
  return {
    input: catalog.require(ref, "per_1m_input_tokens"),
    output: catalog.require(ref, "per_1m_output_tokens"),
    cacheWrite: catalog.require(ref, "per_1m_cache_write_tokens"),
    cacheRead: catalog.require(ref, "per_1m_cache_read_tokens"),
  };
}

export interface LlmCostLine {
  pricing: ProviderPricing;
  usage: Usage;
  quantity: number;
  costUsd: number;
  label: string;
}

/**
 * Custo REAL de uma chamada a partir do usage retornado pela API.
 * Entrada sem cache, escrita de cache, leitura de cache e saída têm preços distintos.
 * Linhas com quantidade 0 de cache são omitidas; entrada e saída sempre aparecem.
 */
export function llmCallCostLines(pricing: LlmPricing, usage: TokenUsage): LlmCostLine[] {
  const candidates: { pricing: ProviderPricing; usage: Usage; label: string; always: boolean }[] = [
    { pricing: pricing.input, usage: { inputTokens: usage.inputTokens }, label: "entrada", always: true },
    { pricing: pricing.output, usage: { outputTokens: usage.outputTokens }, label: "saída", always: true },
    {
      pricing: pricing.cacheWrite,
      usage: { cacheWriteTokens: usage.cacheCreationInputTokens },
      label: "escrita de cache",
      always: false,
    },
    {
      pricing: pricing.cacheRead,
      usage: { cacheReadTokens: usage.cacheReadInputTokens },
      label: "leitura de cache",
      always: false,
    },
  ];
  return candidates
    .map((c) => ({ ...c, ...costForUsage(c.pricing, c.usage) }))
    .filter((c) => c.always || c.quantity > 0)
    .map(({ pricing: p, usage: u, quantity, costUsd, label }) => ({ pricing: p, usage: u, quantity, costUsd, label }));
}

export function llmCallCostUsd(pricing: LlmPricing, usage: TokenUsage): number {
  return llmCallCostLines(pricing, usage).reduce((a, l) => a + l.costUsd, 0);
}

/**
 * Pior caso de uma operação de LLM ANTES de executá-la: todas as tentativas usando
 * o máximo de tokens de saída. Usado para checar o orçamento da campanha antes de chamar.
 */
export function worstCaseLlmCostUsd(
  pricing: LlmPricing,
  params: { estimatedInputTokens: number; maxOutputTokens: number; maxAttempts: number },
): number {
  const perAttempt =
    priceUnits(pricing.input, params.estimatedInputTokens) + priceUnits(pricing.output, params.maxOutputTokens);
  return perAttempt * params.maxAttempts;
}

// ---------- Pricing resolvido para um nível de qualidade ----------

export interface ResolvedPricing {
  llm: LlmPricing;
  video: ProviderPricing;
  presenter?: ProviderPricing;
  audio: ProviderPricing;
  rendering: ProviderPricing;
}

export function resolvePricing(settings: QualitySettings, catalog: PricingCatalog): ResolvedPricing {
  return {
    llm: resolveLlmPricing(settings.llm, catalog),
    video: catalog.requireOne(settings.video),
    presenter: catalog.requireOne(RUNWAY_PRESENTER),
    audio: catalog.requireOne(settings.audio),
    rendering: catalog.requireOne(settings.rendering),
  };
}

function lineItem(
  pricing: ProviderPricing,
  usage: Usage,
  meta: { category: CostCategory; phase: CostPhase; description: string; sceneId?: string },
): CostLineItem {
  const { quantity, costUsd } = costForUsage(pricing, usage);
  return {
    ...meta,
    provider: pricing.provider,
    model: pricing.model,
    unit: pricing.unit,
    quantity,
    unitPriceUsd: pricing.priceUsd,
    subtotalUsd: roundUsd(costUsd),
    isPlaceholderPrice: pricing.isPlaceholder,
  };
}

// ---------- Estimativas ----------

export function sceneVideoUsage(scene: Pick<ScenePlan, "estimatedGenerationSeconds"> & Partial<Pick<ScenePlan, "duration">>, pricing?: ProviderPricing): Usage {
  const seconds = pricing?.model === RUNWAY_PRESENTER.model ? presenterBilledSeconds(scene.duration ?? scene.estimatedGenerationSeconds) : pricing?.provider === RUNWAY_VIDEO.provider ? runwayDuration(scene.estimatedGenerationSeconds) : scene.estimatedGenerationSeconds;
  return { seconds, generations: 1 };
}

export function narrationUsage(plan: Pick<CreativePlan, "scenes" | "duration">): Usage {
  // Caracteres do texto FALADO (narração contínua normalizada): é o que o TTS cobra.
  return { characters: spokenNarrationCharacters(plan), seconds: plan.duration, generations: 1 };
}

export function renderUsage(plan: Pick<CreativePlan, "duration">): Usage {
  return { seconds: plan.duration, generations: 1 };
}

/** Custo estimado (USD, sem arredondar) para gerar o vídeo de UMA cena. 0 se não usa IA. */
export function estimateSceneVideoCostUsd(scene: ScenePlan, videoPricing: ProviderPricing): number {
  if (!scene.requiresGeneratedVideo) return 0;
  return costForUsage(videoPricing, sceneVideoUsage(scene, videoPricing)).costUsd;
}

/** Linhas de custo FUTURO (vídeo por cena, áudio, render) de um plano. */
export function futureCostLines(plan: CreativePlan, pricing: Omit<ResolvedPricing, "llm">): CostLineItem[] {
  return [
    ...plan.scenes
      .filter((s) => s.requiresGeneratedVideo)
      .map((s) =>
        lineItem(s.visualSource === "presenter" ? pricing.presenter! : pricing.video, sceneVideoUsage(s, s.visualSource === "presenter" ? pricing.presenter : pricing.video), {
          category: "video",
          phase: "generation",
          description: `Vídeo IA — cena ${s.order + 1} (${s.estimatedGenerationSeconds}s)`,
          sceneId: s.id,
        }),
      ),
    lineItem(pricing.audio, narrationUsage(plan), {
      category: "audio",
      phase: "generation",
      description: "Narração (TTS)",
    }),
    lineItem(pricing.rendering, renderUsage(plan), {
      category: "rendering",
      phase: "rendering",
      description: "Renderização Remotion",
    }),
  ];
}

export function sumLinesUsd(lines: readonly CostLineItem[], category?: CostCategory): number {
  return lines.filter((l) => category === undefined || l.category === category).reduce((a, l) => a + l.subtotalUsd, 0);
}

export interface EstimateCreativeCostInput {
  reusedNarration?: boolean;
  id: string;
  plan: CreativePlan;
  settings: QualitySettings;
  pricing: Omit<ResolvedPricing, "llm">;
  /** Custo REAL já gasto atribuído a este criativo (vem do ledger). */
  incurred: IncurredCost;
  exchangeRate: number;
  createdAt: string;
}

/**
 * Estimativa de um criativo já planejado:
 *   JÁ INCORRIDO (real, do ledger) + FUTURO ESTIMADO (vídeo + áudio + render) = TOTAL PROJETADO.
 */
export function estimateCreativeCost(input: EstimateCreativeCostInput): CostEstimate {
  const { plan, settings, pricing, exchangeRate, incurred } = input;
  const breakdown = futureCostLines(plan, pricing).filter(line => !(input.reusedNarration && line.category === "audio"));
  const futureUsd = sumLinesUsd(breakdown);
  const projectedUsd = incurred.llmCost.usd + futureUsd;

  return {
    kind: "estimate",
    id: input.id,
    creativeId: plan.id,
    quality: settings.quality,
    incurred,
    videoCost: toMoney(sumLinesUsd(breakdown, "video"), exchangeRate),
    audioCost: toMoney(sumLinesUsd(breakdown, "audio"), exchangeRate),
    renderingCost: toMoney(sumLinesUsd(breakdown, "rendering"), exchangeRate),
    estimatedAdditionalUsd: roundUsd(futureUsd),
    estimatedAdditionalBrl: roundBrl(usdToBrl(futureUsd, exchangeRate)),
    projectedTotalUsd: roundUsd(projectedUsd),
    projectedTotalBrl: roundBrl(incurred.llmCost.brl + usdToBrl(futureUsd, exchangeRate)),
    exchangeRate,
    generatedVideoSeconds: generatedVideoSeconds(plan),
    finalVideoSeconds: plan.duration,
    breakdown,
    containsPlaceholderPrices: breakdown.some((l) => l.isPlaceholderPrice),
    createdAt: input.createdAt,
  };
}

export interface PresetRangeEstimate {
  min: Money;
  max: Money;
  generatedVideoSeconds: QualitySettings["generatedVideoSeconds"];
  finalVideoSeconds: QualitySettings["finalVideoSeconds"];
  containsPlaceholderPrices: boolean;
}

/** Faixa de custo de um preset ANTES do planejamento (para os cards de qualidade). */
export function estimatePresetRange(
  settings: QualitySettings,
  pricing: ResolvedPricing,
  exchangeRate: number,
): PresetRangeEstimate {
  const llmUsd =
    priceUnits(pricing.llm.input, settings.llmTokensPerCreative.input) +
    priceUnits(pricing.llm.output, settings.llmTokensPerCreative.output);

  const totalFor = (genSeconds: number, finalSeconds: number) => {
    const videoUsd = costForUsage(pricing.video, {
      seconds: genSeconds,
      generations: Math.ceil(genSeconds / ASSUMED_SECONDS_PER_GENERATED_CLIP),
    }).costUsd;
    const audioUsd = costForUsage(pricing.audio, {
      characters: Math.round(finalSeconds * settings.narrationCharsPerSecond),
      seconds: finalSeconds,
      generations: 1,
    }).costUsd;
    const renderUsd = costForUsage(pricing.rendering, { seconds: finalSeconds, generations: 1 }).costUsd;
    return llmUsd + videoUsd + audioUsd + renderUsd;
  };

  return {
    min: toMoney(totalFor(settings.generatedVideoSeconds.min, settings.finalVideoSeconds.min), exchangeRate),
    max: toMoney(totalFor(settings.generatedVideoSeconds.max, settings.finalVideoSeconds.max), exchangeRate),
    generatedVideoSeconds: settings.generatedVideoSeconds,
    finalVideoSeconds: settings.finalVideoSeconds,
    containsPlaceholderPrices: [pricing.video, pricing.audio, pricing.rendering, pricing.llm.input].some(
      (p) => p.isPlaceholder,
    ),
  };
}

// ---------- Custo efetivo ----------

export interface BuildActualCostInput {
  id: string;
  campaignId: string;
  jobId: string | null;
  creativeId: string | null;
  sceneId: string | null;
  attemptId: string | null;
  llmCallId?: string | null;
  operation: CostOperation;
  category: CostCategory;
  description: string;
  pricing: ProviderPricing;
  usage: Usage;
  exchangeRate: number;
  simulated: boolean;
  createdAt: string;
}

/** Constrói o registro de custo EFETIVO de uma chamada a partir do consumo faturado. */
export function buildActualCost(input: BuildActualCostInput): GenerationCost {
  const { quantity, costUsd } = costForUsage(input.pricing, input.usage);
  return {
    kind: "actual",
    id: input.id,
    campaignId: input.campaignId,
    jobId: input.jobId,
    creativeId: input.creativeId,
    sceneId: input.sceneId,
    attemptId: input.attemptId,
    llmCallId: input.llmCallId ?? null,
    operation: input.operation,
    category: input.category,
    description: input.description,
    provider: input.pricing.provider,
    model: input.pricing.model,
    unit: input.pricing.unit,
    quantity,
    unitPriceUsd: input.pricing.priceUsd,
    costUsd: roundUsd(costUsd),
    exchangeRate: input.exchangeRate,
    costBrl: roundBrl(usdToBrl(costUsd, input.exchangeRate)),
    simulated: input.simulated,
    createdAt: input.createdAt,
  };
}
