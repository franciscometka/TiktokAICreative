import type {
  BudgetExceededDecision,
  BudgetScope,
  CostBudget,
  OverBudgetAuthorization,
} from "@/domain/cost";
import { roundBrl, toCents } from "@/lib/money";

/**
 * Regras PURAS de orçamento. Comparações em centavos inteiros.
 *
 * Princípio: exceder o limite NUNCA acontece automaticamente. O resultado é uma
 * decisão (BUDGET_EXCEEDED) que a interface apresenta ao usuário: Cancelar ou,
 * se a política permitir, Autorizar exceder até um teto específico.
 */

export class OverBudgetNotAllowedError extends Error {
  override name = "OverBudgetNotAllowedError";
}

export interface BudgetCheckInput {
  budget: CostBudget;
  authorization?: OverBudgetAuthorization;
  /** Custo já comprometido deste criativo (gasto real + parcela já incorrida). */
  creativeCurrentBrl: number;
  /** Custo já comprometido da campanha inteira, INCLUINDO este criativo. */
  campaignCurrentBrl: number;
  /** Custo adicional estimado da ação que se pretende executar. */
  additionalBrl: number;
}

export type BudgetCheckResult =
  | { kind: "WITHIN_BUDGET"; usesOverBudgetAuthorization: boolean }
  | BudgetExceededDecision;

function effectiveLimitCents(budgetBrl: number, authorizedUpToBrl: number | undefined): number {
  return Math.max(toCents(budgetBrl), toCents(authorizedUpToBrl ?? 0));
}

function decision(
  scope: BudgetScope,
  currentBrl: number,
  additionalBrl: number,
  budgetBrl: number,
  budget: CostBudget,
): BudgetExceededDecision {
  return {
    kind: "BUDGET_EXCEEDED",
    scope,
    currentCostBrl: roundBrl(currentBrl),
    additionalEstimatedCostBrl: roundBrl(additionalBrl),
    newEstimatedTotalBrl: roundBrl(currentBrl + additionalBrl),
    budgetBrl,
    canAuthorizeOverBudget: budget.allowOverBudget,
  };
}

export function checkBudget(input: BudgetCheckInput): BudgetCheckResult {
  const { budget, authorization, creativeCurrentBrl, campaignCurrentBrl, additionalBrl } = input;
  if (additionalBrl < 0) throw new RangeError("additionalBrl não pode ser negativo");

  const creativeNew = toCents(creativeCurrentBrl + additionalBrl);
  const campaignNew = toCents(campaignCurrentBrl + additionalBrl);

  const creativeLimit = effectiveLimitCents(budget.maxCostPerCreativeBrl, authorization?.creativeUpToBrl);
  if (creativeNew > creativeLimit) {
    return decision("creative", creativeCurrentBrl, additionalBrl, budget.maxCostPerCreativeBrl, budget);
  }

  const campaignLimit = effectiveLimitCents(budget.maxCostPerCampaignBrl, authorization?.campaignUpToBrl);
  if (campaignNew > campaignLimit) {
    return decision("campaign", campaignCurrentBrl, additionalBrl, budget.maxCostPerCampaignBrl, budget);
  }

  return {
    kind: "WITHIN_BUDGET",
    usesOverBudgetAuthorization:
      creativeNew > toCents(budget.maxCostPerCreativeBrl) ||
      campaignNew > toCents(budget.maxCostPerCampaignBrl),
  };
}

/**
 * Converte uma decisão BUDGET_EXCEEDED + consentimento humano em autorização.
 * A autorização cobre SOMENTE até o novo total apresentado ao usuário — não é um cheque em branco.
 */
export function authorizeOverBudget(
  pending: BudgetExceededDecision,
  budget: CostBudget,
  authorizedAt: string,
  existing?: OverBudgetAuthorization,
): OverBudgetAuthorization {
  if (!budget.allowOverBudget) {
    throw new OverBudgetNotAllowedError(
      "A política de orçamento não permite exceder o limite. Aumente o limite ou cancele.",
    );
  }
  const next: OverBudgetAuthorization = { ...existing, authorizedAt };
  if (pending.scope === "creative") {
    next.creativeUpToBrl = Math.max(existing?.creativeUpToBrl ?? 0, pending.newEstimatedTotalBrl);
  } else {
    next.campaignUpToBrl = Math.max(existing?.campaignUpToBrl ?? 0, pending.newEstimatedTotalBrl);
  }
  return next;
}
