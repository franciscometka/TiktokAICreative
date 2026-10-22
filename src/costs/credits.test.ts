import { describe, expect, it } from "vitest";
import {
  actualCreditsFromBrl, actualCreditsFromBrlSum, apportion, creditsBalance, creditsFromEstimate, dayKey, estimatedCreditsFromBrl,
  formatCredits, inPeriod, monthPeriod, periodDays, remainingAfter,
} from "./credits";

/** L8.2 — matemática pura dos créditos (1 BRL = 100 créditos nos exemplos). */

describe("BRL → créditos", () => {
  it("exemplos do modelo (100 créditos por real)", () => {
    expect(actualCreditsFromBrl(1, 100)).toBe(100);
    expect(actualCreditsFromBrl(5, 100)).toBe(500);
    expect(actualCreditsFromBrl(8.37, 100)).toBe(837);
    expect(actualCreditsFromBrl(10, 100)).toBe(1000);
  });

  it("sem erro de ponto flutuante (8,37 × 100 nunca vira 836,99…)", () => {
    expect(estimatedCreditsFromBrl(8.37, 100)).toBe(837);
    expect(estimatedCreditsFromBrl(0.1 + 0.2, 100)).toBe(30);
    expect(actualCreditsFromBrl(0.1 + 0.2, 100)).toBe(30);
  });

  it("estimativa arredonda para CIMA; real arredonda matematicamente", () => {
    expect(estimatedCreditsFromBrl(8.374, 100)).toBe(838);
    expect(actualCreditsFromBrl(8.374, 100)).toBe(837);
    expect(actualCreditsFromBrl(8.375, 100)).toBe(838);
    expect(estimatedCreditsFromBrl(0.001, 100)).toBe(1);
    expect(actualCreditsFromBrl(0.001, 100)).toBe(0);
    expect(estimatedCreditsFromBrl(0, 100)).toBe(0);
  });

  it("soma real em micro-reais ANTES de converter (sem acumular arredondamento)", () => {
    // 3 × R$ 0,004 = R$ 0,012 → 1 crédito (por entrada daria 0 + 0 + 0).
    expect(actualCreditsFromBrlSum([0.004, 0.004, 0.004], 100)).toBe(1);
    expect(actualCreditsFromBrlSum([], 100)).toBe(0);
  });

  it("fator configurável", () => {
    expect(actualCreditsFromBrl(8.37, 10)).toBe(84);
    expect(estimatedCreditsFromBrl(8.37, 10)).toBe(84);
    expect(actualCreditsFromBrl(1, 1)).toBe(1);
  });
});

describe("repartição (maior resto)", () => {
  it("partes somam exatamente o total; peso zero recebe zero", () => {
    const parts = apportion([1, 1, 1], 100);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(100);
    expect(parts).toEqual([34, 33, 33]);
    expect(apportion([0, 5, 0], 7)).toEqual([0, 7, 0]);
    expect(apportion([0, 0], 10)).toEqual([0, 0]);
    expect(apportion([2, 1], 0)).toEqual([0, 0]);
  });
});

describe("estimativa de vídeo", () => {
  it("quote → créditos estimados com linhas que somam o total", () => {
    const e = creditsFromEstimate({ totalBrl: 11.204, lines: [{ label: "Roteiro", brl: 0.35 }, { label: "Vídeo", brl: 10.5 }, { label: "Render", brl: 0.354 }] }, 100);
    expect(e.total).toBe(1121);
    expect(e.lines.reduce((a, l) => a + l.credits, 0)).toBe(1121);
    expect(e.lines.map((l) => l.label)).toEqual(["Roteiro", "Vídeo", "Render"]);
    expect(creditsFromEstimate({ totalBrl: 1 }, 100)).toEqual({ total: 100, lines: [] });
  });

  it("saldo estimado após gerar nunca negativo", () => {
    expect(remainingAfter(10_000, 1120)).toBe(8880);
    expect(remainingAfter(500, 1120)).toBe(0);
  });
});

describe("saldo", () => {
  it("allowance, used, remaining, overage e estados", () => {
    expect(creditsBalance(0, 10_000)).toEqual({ allowance: 10_000, used: 0, remaining: 10_000, overage: 0, state: "normal" });
    expect(creditsBalance(3240, 10_000)).toMatchObject({ remaining: 6760, overage: 0, state: "normal" });
    expect(creditsBalance(8000, 10_000).state).toBe("low"); // 20% exatos
    expect(creditsBalance(7999, 10_000).state).toBe("normal");
    expect(creditsBalance(10_000, 10_000)).toMatchObject({ remaining: 0, overage: 0, state: "empty" });
    expect(creditsBalance(10_340, 10_000)).toMatchObject({ remaining: 0, overage: 340, state: "empty" });
  });
});

describe("período mensal no fuso", () => {
  const tz = "America/Sao_Paulo";

  it("mês corrente começa à meia-noite de Brasília (03:00 UTC)", () => {
    const p = monthPeriod(new Date("2026-10-22T15:00:00Z"), tz);
    expect(p).toEqual({ start: "2026-10-01T03:00:00.000Z", end: "2026-11-01T03:00:00.000Z", timeZone: tz });
  });

  it("virada de período: 23:30 de 31/10 em Brasília ainda é outubro; 00:10 de 1/11 já é novembro", () => {
    expect(monthPeriod(new Date("2026-11-01T02:30:00Z"), tz).start).toBe("2026-10-01T03:00:00.000Z");
    expect(monthPeriod(new Date("2026-11-01T03:10:00Z"), tz).start).toBe("2026-11-01T03:00:00.000Z");
    const oct = monthPeriod(new Date("2026-10-15T12:00:00Z"), tz);
    expect(inPeriod("2026-11-01T02:59:59.000Z", oct)).toBe(true);
    expect(inPeriod("2026-11-01T03:00:00.000Z", oct)).toBe(false);
    expect(inPeriod("2026-10-01T02:59:59.000Z", oct)).toBe(false);
  });

  it("dezembro → janeiro e outro fuso explícito", () => {
    expect(monthPeriod(new Date("2026-12-20T12:00:00Z"), tz).end).toBe("2027-01-01T03:00:00.000Z");
    expect(monthPeriod(new Date("2026-10-22T12:00:00Z"), "UTC")).toMatchObject({ start: "2026-10-01T00:00:00.000Z", end: "2026-11-01T00:00:00.000Z" });
  });

  it("dias do período até hoje, na data local", () => {
    expect(dayKey("2026-10-22T02:00:00Z", tz)).toBe("2026-10-21");
    const days = periodDays(monthPeriod(new Date("2026-10-05T15:00:00Z"), tz), new Date("2026-10-05T15:00:00Z"));
    expect(days).toEqual(["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05"]);
    expect(periodDays(monthPeriod(new Date("2026-10-31T20:00:00Z"), tz), new Date("2026-10-31T20:00:00Z"))).toHaveLength(31);
  });

  it("formatação pt-BR", () => {
    expect(formatCredits(1840)).toBe("1.840");
    expect(formatCredits(10_000)).toBe("10.000");
  });
});
