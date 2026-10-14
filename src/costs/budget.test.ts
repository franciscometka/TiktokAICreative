import { describe, expect, it } from "vitest";
import type { CostBudget } from "@/domain/cost";
import { authorizeOverBudget, checkBudget, OverBudgetNotAllowedError } from "./budget";

const budget: CostBudget = { maxCostPerCreativeBrl: 15, maxCostPerCampaignBrl: 50, allowOverBudget: true };

describe("checkBudget — limite por vídeo", () => {
  it("dentro do limite", () => {
    const r = checkBudget({ budget, creativeCurrentBrl: 7, campaignCurrentBrl: 7, additionalBrl: 4 });
    expect(r).toEqual({ kind: "WITHIN_BUDGET", usesOverBudgetAuthorization: false });
  });

  it("exatamente no limite é permitido (comparação em centavos)", () => {
    const r = checkBudget({ budget, creativeCurrentBrl: 10.1, campaignCurrentBrl: 10.1, additionalBrl: 4.9 });
    expect(r.kind).toBe("WITHIN_BUDGET");
  });

  it("1 centavo acima retorna BUDGET_EXCEEDED com os valores para a interface", () => {
    const r = checkBudget({ budget, creativeCurrentBrl: 11, campaignCurrentBrl: 11, additionalBrl: 4.01 });
    expect(r).toEqual({
      kind: "BUDGET_EXCEEDED",
      scope: "creative",
      currentCostBrl: 11,
      additionalEstimatedCostBrl: 4.01,
      newEstimatedTotalBrl: 15.01,
      budgetBrl: 15,
      canAuthorizeOverBudget: true,
    });
  });

  it("canAuthorizeOverBudget reflete a política", () => {
    const r = checkBudget({
      budget: { ...budget, allowOverBudget: false },
      creativeCurrentBrl: 14,
      campaignCurrentBrl: 14,
      additionalBrl: 4,
    });
    expect(r.kind === "BUDGET_EXCEEDED" && r.canAuthorizeOverBudget).toBe(false);
  });

  it("rejeita custo adicional negativo", () => {
    expect(() => checkBudget({ budget, creativeCurrentBrl: 0, campaignCurrentBrl: 0, additionalBrl: -1 })).toThrow();
  });
});

describe("checkBudget — limite por campanha", () => {
  it("excede a campanha mesmo com o criativo dentro do limite", () => {
    const r = checkBudget({ budget, creativeCurrentBrl: 0, campaignCurrentBrl: 45, additionalBrl: 10 });
    expect(r.kind === "BUDGET_EXCEEDED" && r.scope).toBe("campaign");
    if (r.kind === "BUDGET_EXCEEDED") {
      expect(r.newEstimatedTotalBrl).toBe(55);
      expect(r.budgetBrl).toBe(50);
    }
  });
});

describe("autorização explícita para exceder", () => {
  it("cobre SOMENTE até o novo total apresentado ao usuário", () => {
    const decision = checkBudget({ budget, creativeCurrentBrl: 11, campaignCurrentBrl: 11, additionalBrl: 6 });
    if (decision.kind !== "BUDGET_EXCEEDED") throw new Error("esperado exceder");
    const auth = authorizeOverBudget(decision, budget, "t");
    expect(auth.creativeUpToBrl).toBe(17);

    const same = checkBudget({ budget, authorization: auth, creativeCurrentBrl: 11, campaignCurrentBrl: 11, additionalBrl: 6 });
    expect(same).toEqual({ kind: "WITHIN_BUDGET", usesOverBudgetAuthorization: true });

    // Uma nova regeneração além do teto autorizado exige NOVA decisão.
    const more = checkBudget({ budget, authorization: auth, creativeCurrentBrl: 17, campaignCurrentBrl: 17, additionalBrl: 4 });
    expect(more.kind).toBe("BUDGET_EXCEEDED");
  });

  it("é proibida quando allowOverBudget = false", () => {
    const strict = { ...budget, allowOverBudget: false };
    const decision = checkBudget({ budget: strict, creativeCurrentBrl: 14, campaignCurrentBrl: 14, additionalBrl: 4 });
    if (decision.kind !== "BUDGET_EXCEEDED") throw new Error("esperado exceder");
    expect(() => authorizeOverBudget(decision, strict, "t")).toThrow(OverBudgetNotAllowedError);
  });

  it("autorização de campanha não afeta o escopo de criativo", () => {
    const decision = checkBudget({ budget, creativeCurrentBrl: 0, campaignCurrentBrl: 48, additionalBrl: 5 });
    if (decision.kind !== "BUDGET_EXCEEDED") throw new Error("esperado exceder");
    const auth = authorizeOverBudget(decision, budget, "t");
    expect(auth).toEqual({ campaignUpToBrl: 53, authorizedAt: "t" });
  });
});
