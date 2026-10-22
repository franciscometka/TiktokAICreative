import { describe, expect, it } from "vitest";
import { loadAppConfig } from "@/config/env";
import type { CostCategory, GenerationCost } from "@/domain/cost";
import { buildCreditsView, creditGroupOf, creditsSummary, MIN_VIDEOS_FOR_AVERAGE, videosLabel, type ProjectCreditInfo } from "./credits";
import type { V2EstimateView } from "./create-v2";

/** L8.2 — visão de créditos derivada do ledger (sem tabela de saldo, sem débito gravado). */

const config = { perBrl: 100, monthlyAllowance: 10_000, timeZone: "America/Sao_Paulo" };
const NOW = new Date("2026-10-22T15:00:00Z");
let seq = 0;
function entry(campaignId: string, category: CostCategory, costBrl: number, createdAt: string, simulated = false): GenerationCost {
  seq += 1;
  return {
    kind: "actual", id: `e${seq}`, campaignId, jobId: `job_${campaignId}`, creativeId: null, sceneId: null, attemptId: null, llmCallId: null,
    operation: "generate", category, description: "x", provider: "p", model: "m", unit: "request", quantity: 1, unitPriceUsd: 0,
    costUsd: 0, exchangeRate: 5, costBrl, simulated, createdAt,
  } as unknown as GenerationCost;
}
const estimate30: V2EstimateView = { duration: 30, quality: "high", clips: 4, totalBrl: 22.72, lines: [], provisional: false };
const project = (campaignId: string, name: string, videoCompletedAt: string | null, extra: Partial<ProjectCreditInfo> = {}): ProjectCreditInfo =>
  ({ campaignId, name, targetSeconds: 30, videoCompletedAt, active: false, ...extra });

describe("créditos do mês", () => {
  it("mês vazio: saldo = franquia, sem gráfico nem histórico", () => {
    const view = buildCreditsView({ config, entries: [], projects: [], estimates: [estimate30], now: NOW });
    expect(view).toMatchObject({ used: 0, remaining: 10_000, overage: 0, state: "normal", usedBrl: 0, videosGenerated: 0 });
    expect(view.dailyUsage).toEqual([]);
    expect(view.recent).toEqual([]);
    expect(view.usageByService).toEqual([]);
  });

  it("mês com consumo: uso = Σ custo real × fator; simulado e mês anterior não contam", () => {
    const entries = [
      entry("c1", "llm", 0.35, "2026-10-22T12:00:00Z"),
      entry("c1", "ugc_reference", 1.42, "2026-10-22T12:05:00Z"),
      entry("c1", "ugc_scene", 8.9, "2026-10-22T12:30:00Z"),
      entry("c1", "rendering", 0.2, "2026-10-22T12:42:00Z"),
      entry("c2", "llm", 5, "2026-10-03T12:00:00Z"),
      entry("c2", "video", 99, "2026-10-04T12:00:00Z", true), // mock: nenhum dinheiro gasto
      entry("c3", "video", 50, "2026-09-30T23:00:00Z"), // 20:00 de 30/09 em Brasília: setembro
    ];
    const view = buildCreditsView({ config, entries, projects: [project("c1", "Secador Taiff", "2026-10-22T12:45:00Z"), project("c2", "Perfume", null)], estimates: [estimate30], now: NOW });
    expect(view.used).toBe(1587);
    expect(view.usedBrl).toBe(15.87);
    expect(view.remaining).toBe(8413);
    expect(view.videosGenerated).toBe(1);
    expect(view.usageByService.map((s) => [s.label, s.credits])).toEqual([["Planejamento IA", 535], ["Vídeo IA", 890], ["Referência visual", 142], ["Renderização", 20]].sort((a, b) => (b[1] as number) - (a[1] as number)));
    expect(view.usageByService.reduce((a, s) => a + s.credits, 0)).toBe(view.used);
    expect(view.dailyUsage).toHaveLength(22);
    expect(view.dailyUsage.reduce((a, d) => a + d.credits, 0)).toBe(view.used);
    expect(view.dailyUsage.find((d) => d.date === "2026-10-03")?.credits).toBe(500);
  });

  it("histórico agrupado por projeto com detalhe que soma o total", () => {
    const entries = [
      entry("c1", "llm", 0.35, "2026-10-22T12:00:00Z"),
      entry("c1", "ugc_reference", 1.42, "2026-10-22T12:05:00Z"),
      entry("c1", "ugc_scene", 4.45, "2026-10-22T12:20:00Z"),
      entry("c1", "ugc_scene", 4.45, "2026-10-22T12:30:00Z"),
      entry("c1", "rendering", 0.2, "2026-10-22T12:42:00Z"),
      entry("c2", "llm", 0.3, "2026-10-21T10:00:00Z"),
    ];
    const view = buildCreditsView({ config, entries, projects: [project("c1", "Secador Taiff", "2026-10-22T12:45:00Z"), project("c2", "Perfume", null)], estimates: [], now: NOW });
    expect(view.recent).toHaveLength(2);
    const [taiff, perfume] = view.recent;
    expect(taiff).toMatchObject({ projectId: "c1", name: "Secador Taiff", kind: "Vídeo completo", credits: 1087, at: "2026-10-22T12:42:00Z" });
    expect(taiff!.breakdown).toEqual([{ label: "Vídeo IA", credits: 890 }, { label: "Referência visual", credits: 142 }, { label: "Planejamento IA", credits: 35 }, { label: "Renderização", credits: 20 }]);
    expect(perfume).toMatchObject({ name: "Perfume", kind: "Roteiro", credits: 30 });
    expect(JSON.stringify(view)).not.toMatch(/provider|model|prompt|job_c1|"e\d+"/);
  });

  it("categorias técnicas viram nomes de produto", () => {
    expect(creditGroupOf("ugc_scene").label).toBe("Vídeo IA");
    expect(creditGroupOf("broll").label).toBe("Vídeo IA");
    expect(creditGroupOf("llm").label).toBe("Planejamento IA");
    expect(creditGroupOf("ugc_reference").label).toBe("Referência visual");
    expect(creditGroupOf("rendering").label).toBe("Renderização");
    expect(creditGroupOf("audio").label).toBe("Áudio");
  });

  it("estados low e empty; excedente informativo", () => {
    const low = buildCreditsView({ config, entries: [entry("c1", "video", 85, "2026-10-10T12:00:00Z")], projects: [], estimates: [], now: NOW });
    expect(low).toMatchObject({ used: 8500, remaining: 1500, state: "low" });
    const over = buildCreditsView({ config, entries: [entry("c1", "video", 103.4, "2026-10-10T12:00:00Z")], projects: [], estimates: [], now: NOW });
    expect(over).toMatchObject({ used: 10_340, remaining: 0, overage: 340, state: "empty" });
  });
});

describe("≈ vídeos de 30s (nunca inventado)", () => {
  it("menos de MIN vídeos reais: usa a estimativa atual de 30s (para cima)", () => {
    const view = buildCreditsView({ config, entries: [], projects: [], estimates: [estimate30], now: NOW });
    expect(view.estimatedVideos).toEqual({ seconds: 30, count: 4, creditsPerVideo: 2272, basis: "estimate" });
    expect(videosLabel(view)).toBe("≈ 4 vídeos de 30s");
  });

  it("com vídeos reais suficientes: média real", () => {
    const projects = Array.from({ length: MIN_VIDEOS_FOR_AVERAGE }, (_, i) => project(`v${i}`, `V${i}`, `2026-10-1${i}T12:00:00Z`));
    const entries = [entry("v0", "video", 10, "2026-10-10T11:00:00Z"), entry("v1", "video", 12, "2026-10-11T11:00:00Z"), entry("v2", "video", 11.01, "2026-10-12T11:00:00Z")];
    const view = buildCreditsView({ config, entries, projects, estimates: [estimate30], now: NOW });
    expect(view.estimatedVideos).toMatchObject({ basis: "average", creditsPerVideo: 1101, count: Math.floor(view.remaining / 1101) });
  });

  it("sem base confiável (estimativa provisória e sem vídeos): não mostra", () => {
    const view = buildCreditsView({ config, entries: [], projects: [], estimates: [{ ...estimate30, provisional: true }], now: NOW });
    expect(view.estimatedVideos).toBeNull();
    expect(videosLabel(view)).toBeNull();
  });

  it("saldo zero: equivalência some (0 vídeos não é mostrado)", () => {
    const view = buildCreditsView({ config, entries: [entry("c1", "video", 100, "2026-10-10T12:00:00Z")], projects: [], estimates: [estimate30], now: NOW });
    expect(view.estimatedVideos?.count).toBe(0);
    expect(videosLabel(view)).toBeNull();
  });
});

describe("configuração", () => {
  it("produção sem as variáveis: indisponível (nunca saldo inventado)", () => {
    expect(loadAppConfig({ NODE_ENV: "production" }).credits).toBeNull();
    expect(loadAppConfig({ NODE_ENV: "production", CREDITS_PER_BRL: "100" }).credits).toBeNull();
    expect(creditsSummary({ configured: false })).toBeNull();
  });

  it("explícito em produção; defaults documentados só fora de produção", () => {
    expect(loadAppConfig({ NODE_ENV: "production", CREDITS_PER_BRL: "100", MONTHLY_CREDIT_ALLOWANCE: "10000" }).credits).toEqual({ perBrl: 100, monthlyAllowance: 10_000, timeZone: "America/Sao_Paulo" });
    expect(loadAppConfig({}).credits).toEqual({ perBrl: 100, monthlyAllowance: 10_000, timeZone: "America/Sao_Paulo" });
    expect(loadAppConfig({ CREDITS_PER_BRL: "50", MONTHLY_CREDIT_ALLOWANCE: "2000", CREDITS_TIMEZONE: "UTC" }).credits).toEqual({ perBrl: 50, monthlyAllowance: 2000, timeZone: "UTC" });
  });

  it("valores inválidos falham na validação", () => {
    expect(() => loadAppConfig({ CREDITS_PER_BRL: "0", MONTHLY_CREDIT_ALLOWANCE: "100" })).toThrow();
    expect(() => loadAppConfig({ CREDITS_PER_BRL: "abc", MONTHLY_CREDIT_ALLOWANCE: "100" })).toThrow();
    expect(() => loadAppConfig({ CREDITS_TIMEZONE: "Marte/Olympus" })).toThrow();
  });
});
