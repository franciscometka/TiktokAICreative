import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildCreditsView, type CreditsSummary, type CreditsView } from "@/application/credits";
import type { CostCategory, GenerationCost } from "@/domain/cost";
import { CreditsBadge, CreditsPanel } from "../shell/credits-badge";
import { CreditsScreen, CreditsUnavailable, DailyUsageChart, historyTimeLabel } from "./credits-view";

/** L8.2 — UI de créditos: badge, painel, tela (vazia, com consumo, low, zero), gráfico e histórico. */

const config = { perBrl: 100, monthlyAllowance: 10_000, timeZone: "America/Sao_Paulo" };
const NOW = new Date("2026-10-22T15:00:00Z");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const entry = (campaignId: string, category: CostCategory, costBrl: number, createdAt: string): GenerationCost =>
  ({ kind: "actual", id: `${campaignId}-${category}-${createdAt}`, campaignId, jobId: null, creativeId: null, sceneId: null, attemptId: null, llmCallId: null, operation: "generate", category, description: "x", provider: "p", model: "m", unit: "request", quantity: 1, unitPriceUsd: 0, costUsd: 0, exchangeRate: 5, costBrl, simulated: false, createdAt }) as unknown as GenerationCost;
const estimate = { duration: 30 as const, quality: "high" as const, clips: 4, totalBrl: 22.72, lines: [], provisional: false };
const view = (entries: GenerationCost[]): CreditsView => buildCreditsView({ config, entries, estimates: [estimate], now: NOW, projects: [{ campaignId: "c1", name: "Secador Taiff", targetSeconds: 30, videoCompletedAt: "2026-10-22T12:45:00Z", active: false }] });
const summary = (remaining: number, state: CreditsSummary["state"]): CreditsSummary => ({ creditsPerBrl: 100, remaining, allowance: 10_000, state, estimatedVideos: { seconds: 30, count: Math.floor(remaining / 2272), creditsPerVideo: 2272, basis: "estimate" } });

describe("badge e painel do shell", () => {
  it("saldo real com link para Créditos e tooltip com franquia e vídeos", () => {
    const html = renderToStaticMarkup(createElement(CreditsBadge, { summary: summary(6760, "normal") }));
    expect(html).toContain('href="/credits"');
    for (const t of ["6.760", "Saldo mensal", "6.760 / 10.000", "≈ 2 vídeos de 30s", "Ver uso →"]) expect(html).toContain(t);
    expect(html).toContain('data-credits="normal"');
  });

  it("low = âmbar; empty = danger (sem vermelho enquanto houver crédito)", () => {
    const low = renderToStaticMarkup(createElement(CreditsBadge, { summary: summary(1500, "low") }));
    expect(low).toContain("text-warning");
    expect(low).not.toContain("text-danger");
    const empty = renderToStaticMarkup(createElement(CreditsPanel, { summary: summary(0, "empty") }));
    expect(empty).toContain("text-danger");
    expect(empty).toContain("Sem saldo neste mês");
    expect(empty).not.toContain("≈");
  });

  it("sem configuração: indisponível, sem número; carregando: placeholder", () => {
    const off = renderToStaticMarkup(createElement(CreditsPanel, { summary: null }));
    expect(off).toContain("Créditos indisponíveis");
    expect(text(off)).not.toMatch(/\d/);
    expect(text(renderToStaticMarkup(createElement(CreditsBadge, { summary: null, loading: true })))).not.toMatch(/\d|indisponíveis/);
  });
});

describe("tela Créditos", () => {
  it("sem uso no mês: saldo cheio e mensagem, sem gráfico nem histórico", () => {
    const html = renderToStaticMarkup(createElement(CreditsScreen, { view: view([]), now: NOW }));
    const t = text(html);
    for (const s of ["Créditos", "Acompanhe o consumo do seu estúdio.", "Saldo disponível", "10.000", "Nenhum crédito utilizado neste mês.", "≈ 4 vídeos de 30s", "Outubro de 2026 · horário de Brasília"]) expect(t).toContain(s);
    expect(html).not.toContain("<svg viewBox");
    expect(t).not.toContain("Histórico");
  });

  it("com consumo: resumo, gráfico, serviços em % e histórico agrupado (valores reais sem ~)", () => {
    const html = renderToStaticMarkup(createElement(CreditsScreen, {
      view: view([entry("c1", "llm", 0.35, "2026-10-22T12:00:00Z"), entry("c1", "ugc_reference", 1.42, "2026-10-22T12:05:00Z"), entry("c1", "ugc_scene", 8.9, "2026-10-22T12:30:00Z"), entry("c1", "rendering", 0.2, "2026-10-22T12:42:00Z")]),
      now: NOW,
    }));
    const t = text(html);
    for (const s of ["8.913", "Uso este mês", "1.087", "Vídeos gerados", "R$ 10,87", "Uso diário", "Consumo por serviço", "Vídeo IA", "82%", "Histórico", "Secador Taiff", "Vídeo completo · Hoje · 09:42", "−1.087", "Total", "Abrir projeto →"]) expect(t).toContain(s);
    expect(t).not.toMatch(/~\s?1\.087/);
    expect(html).toContain("<svg viewBox");
  });

  it("saldo baixo e zero", () => {
    expect(text(renderToStaticMarkup(createElement(CreditsScreen, { view: view([entry("c1", "video", 85, "2026-10-10T12:00:00Z")]), now: NOW })))).toContain("Saldo baixo");
    const zero = text(renderToStaticMarkup(createElement(CreditsScreen, { view: view([entry("c1", "video", 103.4, "2026-10-10T12:00:00Z")]), now: NOW })));
    expect(zero).toContain("Sem saldo");
    expect(zero).toContain("Excedente: 340 créditos acima da franquia");
    expect(zero).not.toContain("≈");
  });

  it("créditos não configurados", () => {
    expect(text(renderToStaticMarkup(createElement(CreditsUnavailable)))).toContain("Créditos indisponíveis");
  });

  it("gráfico sem dados não desenha nada fake", () => {
    const html = renderToStaticMarkup(createElement(DailyUsageChart, { days: [], now: NOW, timeZone: config.timeZone }));
    expect(html).not.toContain("<svg");
    expect(text(html)).toContain("Nenhum crédito utilizado neste mês.");
  });

  it("rótulo de horário no fuso dos créditos", () => {
    expect(historyTimeLabel("2026-10-22T12:42:00Z", NOW, config.timeZone)).toBe("Hoje · 09:42");
    expect(historyTimeLabel("2026-10-21T21:10:00Z", NOW, config.timeZone)).toBe("Ontem · 18:10");
    expect(historyTimeLabel("2026-10-12T12:42:00Z", NOW, config.timeZone)).toBe("12 out · 09:42");
  });
});
