import type { ActualCostSummary } from "@/costs/ledger";
import type { BudgetExceededDecision, CostEstimate } from "@/domain/cost";
import type { Range } from "@/domain/quality";
import { formatBrl, roundBrl } from "@/lib/money";
import { COST_CATEGORY_NAMES } from "./labels";

/**
 * Traduz os tipos de custo do domínio em dados prontos para a interface.
 * NÃO calcula custo: só reorganiza o que CostEstimate / ActualCostSummary / BudgetExceededDecision
 * já trazem, mantendo "já incorrido (real)" separado de "futuro (estimado)".
 */

export type FutureCategory = "video" | "audio" | "rendering";

export interface FutureCostLine {
  category: FutureCategory;
  label: string;
  brl: number;
  /** Preço provisório: o provider real ainda não foi configurado. */
  isPlaceholder: boolean;
}

export interface EstimatePresentation {
  estimateId: string;
  /** JÁ UTILIZADO: custo real do planejamento rateado para este criativo. */
  incurred: { label: string; brl: number; simulated: boolean; sharedAmongCreatives: number };
  /** FUTURO ESTIMADO, por categoria. */
  future: FutureCostLine[];
  /** O que a aprovação autoriza gastar ("Gerar por aproximadamente R$X"). */
  futureTotalBrl: number;
  projectedTotalBrl: number;
  generatedVideoSeconds: number;
  finalVideoSeconds: number;
  containsPlaceholderPrices: boolean;
}

const FUTURE_ORDER: readonly FutureCategory[] = ["video", "audio", "rendering"];

export function presentEstimate(estimate: CostEstimate): EstimatePresentation {
  const brlByCategory: Record<FutureCategory, number> = {
    video: estimate.videoCost.brl,
    audio: estimate.audioCost.brl,
    rendering: estimate.renderingCost.brl,
  };
  return {
    estimateId: estimate.id,
    incurred: {
      label: COST_CATEGORY_NAMES.llm,
      brl: estimate.incurred.llmCost.brl,
      simulated: estimate.incurred.simulated,
      sharedAmongCreatives: estimate.incurred.sharedAmongCreatives,
    },
    future: FUTURE_ORDER.map((category) => ({
      category,
      label: COST_CATEGORY_NAMES[category],
      brl: brlByCategory[category],
      isPlaceholder: estimate.breakdown.some((l) => l.category === category && l.isPlaceholderPrice),
    })),
    futureTotalBrl: estimate.estimatedAdditionalBrl,
    projectedTotalBrl: estimate.projectedTotalBrl,
    generatedVideoSeconds: estimate.generatedVideoSeconds,
    finalVideoSeconds: estimate.finalVideoSeconds,
    containsPlaceholderPrices: estimate.containsPlaceholderPrices,
  };
}

export interface ActualCostPresentation {
  totalBrl: number;
  planningBrl: number;
  mediaBrl: number;
  discardedBrl: number;
  /** true = valores de mock; nenhum dinheiro foi gasto. */
  simulated: boolean;
}

export function presentActualCosts(summary: ActualCostSummary): ActualCostPresentation {
  const by = summary.byCategoryBrl;
  return {
    totalBrl: roundBrl(summary.totalBrl),
    planningBrl: roundBrl(by.llm),
    mediaBrl: roundBrl(by.video + by.audio + by.rendering),
    discardedBrl: roundBrl(summary.discardedBrl),
    simulated: summary.includesSimulated,
  };
}

export interface BudgetDecisionPresentation {
  scope: BudgetExceededDecision["scope"];
  scopeLabel: string;
  limitBrl: number;
  currentBrl: number;
  nextBrl: number;
  projectedBrl: number;
  excessBrl: number;
  /** Só o domínio decide se o usuário pode autorizar. */
  canAuthorize: boolean;
  authorizeUpToBrl: number;
}

export function presentBudgetDecision(decision: BudgetExceededDecision): BudgetDecisionPresentation {
  return {
    scope: decision.scope,
    scopeLabel: decision.scope === "creative" ? "Limite por criativo" : "Limite da campanha",
    limitBrl: decision.budgetBrl,
    currentBrl: decision.currentCostBrl,
    nextBrl: decision.additionalEstimatedCostBrl,
    projectedBrl: decision.newEstimatedTotalBrl,
    excessBrl: roundBrl(Math.max(0, decision.newEstimatedTotalBrl - decision.budgetBrl)),
    canAuthorize: decision.canAuthorizeOverBudget,
    authorizeUpToBrl: decision.newEstimatedTotalBrl,
  };
}

export function formatBrlRange(range: Range): string {
  return range.min === range.max ? formatBrl(range.min) : `${formatBrl(range.min)} – ${formatBrl(range.max)}`;
}

const secondsFormatter = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });

export function formatSeconds(seconds: number): string {
  return `${secondsFormatter.format(seconds)}s`;
}

export function formatSecondsRange(range: Range): string {
  return range.min === range.max
    ? formatSeconds(range.min)
    : `${secondsFormatter.format(range.min)}–${formatSeconds(range.max)}`;
}
