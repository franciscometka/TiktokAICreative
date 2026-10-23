import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ShellStatus } from "@/app/api/shell/route";
import { buildGenerationView } from "@/application/generation-view";
import type { ProjectCard } from "@/application/project-v2-view";
import { GENERATION_STATES, sourceFixture } from "@/test/generation-fixtures";
import { GenerationScreen } from "../generation/generation-screen";
import { isDarkRoute } from "../shell/nav";
import { ShellStatusContext } from "../shell/shell-status-context";
import { cardCredits, ProjectLibrary } from "./project-library";

/** L8.6 — biblioteca de Projetos e Result Studio. */

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const status: ShellStatus = { mode: "cloud", worker: { state: "online", lastSeenAt: null }, user: null, credits: { creditsPerBrl: 100, remaining: 8000, allowance: 10_000, state: "normal", estimatedVideos: null } };
const withShell = (el: ReturnType<typeof createElement>, s: ShellStatus | null = status) => renderToStaticMarkup(createElement(ShellStatusContext.Provider, { value: { status: s, now: new Date(0) } }, el));
const card = (id: string, over: Partial<ProjectCard> = {}): ProjectCard => ({
  id, name: `Projeto ${id}`, productName: `Produto ${id}`, thumbnailUrl: `/api/uploads/p/${id}.png`, thumbnailKind: "product", avatarName: "Cristina", durationLabel: "30s",
  status: "ready", statusLabel: "Pronto", createdAt: "2026-10-01T00:00:00Z", dateLabel: "01 out", actualBrl: null, estimatedBrl: null, ...over,
});
const MIXED = [
  card("a", { status: "ready", statusLabel: "Pronto", actualBrl: 19.87 }),
  card("b", { status: "generating", statusLabel: "Gerando", estimatedBrl: 20.52 }),
  card("c", { status: "queued", statusLabel: "Na fila" }),
  card("d", { status: "awaiting_approval", statusLabel: "Aguardando aprovação" }),
  card("e", { status: "failed", statusLabel: "Falhou", thumbnailUrl: null, thumbnailKind: null }),
  card("f", { status: "blocked", statusLabel: "Pausado por segurança" }),
];
const noop = async () => ({ ok: true as const });
const handlers = { startPlanning: noop, authorize: noop, approve: noop, regenerate: noop, retryScene: noop, retryPlanning: noop, estimateChange: async () => ({ ok: false as const, error: { message: "x" } }), refresh: () => undefined };

describe("Projetos — biblioteca", () => {
  it("header, busca com label, filtros reais com contagem, ordenação e cards", () => {
    const html = withShell(createElement(ProjectLibrary, { cards: MIXED }));
    const t = text(html);
    for (const s of ["Projetos", "Seus criativos em um só lugar.", "Novo vídeo", "Todos", "Em produção", "Aguardando aprovação", "Prontos", "Precisam de atenção", "Mais recentes", "Mais antigos", "Maior consumo"]) expect(t).toContain(s);
    expect(html).toContain('placeholder="Buscar projetos..."');
    expect(html).toMatch(/<label[^>]*class="sr-only"[^>]*>Buscar projetos<\/label>/);
    expect(html).toMatch(/aria-pressed="true"[^>]*data-filter="all"/);
    expect(t).not.toMatch(/Rascunho/);
    expect(html).toContain('data-project-grid="6"');
    expect(html).toContain('href="/create"');
  });

  it("status visuais e nenhuma mídia de vídeo no grid", () => {
    const html = withShell(createElement(ProjectLibrary, { cards: MIXED }));
    for (const s of ["ready", "generating", "queued", "awaiting_approval", "failed", "blocked"]) expect(html).toContain(`data-project-status="${s}"`);
    expect(html).not.toMatch(/<video/);
    expect(html).toMatch(/aria-label="Abrir Projeto a — Pronto"/);
    expect(text(html)).toContain("Sem imagem");
    expect(html).toContain('loading="lazy"');
  });

  it("créditos: real no concluído (sem ~), estimativa ~ só em produção, nada sem fator", () => {
    expect(cardCredits(MIXED[0]!, 100)).toBe("1.987 créditos");
    expect(cardCredits(MIXED[1]!, 100)).toBe("~2.052 créditos");
    expect(cardCredits(MIXED[3]!, 100)).toBeNull();
    expect(cardCredits(MIXED[0]!, null)).toBeNull();
  });

  it("vazio: \"Seu estúdio ainda está vazio.\" com ✦ Criar vídeo", () => {
    const t = text(withShell(createElement(ProjectLibrary, { cards: [] })));
    expect(t).toContain("Seu estúdio ainda está vazio.");
    expect(t).toContain("Crie seu primeiro vídeo e ele aparecerá aqui.");
    expect(t).toContain("✦ Criar vídeo");
  });

  it("sem ações mortas: nada de Duplicar/Excluir; sem \"Maior consumo\" sem custo real", () => {
    const html = withShell(createElement(ProjectLibrary, { cards: [card("x", { status: "awaiting_approval", statusLabel: "Aguardando aprovação" })] }));
    expect(text(html)).not.toMatch(/Duplicar|Excluir|Arquivar/);
    expect(text(html)).not.toContain("Maior consumo");
    expect(isDarkRoute("/projects")).toBe(true);
  });
});

describe("Result Studio (projeto concluído)", () => {
  const screen = (s: ShellStatus | null = status) => withShell(createElement(GenerationScreen, { source: GENERATION_STATES.done!, campaignId: "c1", handlers, advancedHref: "/campaigns/c1?view=advanced" }), s);

  it("player final grande, Pronto, metadados reais e as 3 ações", () => {
    const html = screen();
    const t = text(html);
    expect(html).toContain("data-result-studio");
    expect(html).toMatch(/<video[^>]*data-result-player="final"/);
    expect((html.match(/<video/g) ?? []).length).toBe(1);
    for (const s of ["Secador Taiff 2100W", "Pronto", "00:31 · Equilibrado · Cristina", "Baixar vídeo", "Criar outro vídeo", "Voltar aos projetos"]) expect(t).toContain(s);
    expect(t).not.toMatch(/variação/i);
  });

  it("dados do resultado: cenas, data, créditos reais sem ~ e por serviço (somam o total)", () => {
    const t = text(screen());
    for (const s of ["Cenas", "Concluído em", "22 de out. de 2026", "1.987 créditos utilizados", "Créditos por serviço", "Vídeo IA", "Referência visual", "Planejamento IA", "Renderização"]) expect(t).toContain(s);
    const view = buildGenerationView(GENERATION_STATES.done!, { creditsPerBrl: 100 });
    expect(view.result!.breakdown.reduce((s, b) => s + b.credits, 0)).toBe(1987);
    expect(t).not.toMatch(/~1\.987/);
    expect(t).not.toMatch(/resolução|estilo/i);
  });

  it("versões anteriores só quando existem; pedido de mudança honesto", () => {
    const t = text(screen());
    expect(t).toContain("Versões anteriores");
    expect(t).toContain("Nada é cobrado nem alterado nesta etapa.");
    const none = text(withShell(createElement(GenerationScreen, { source: { ...GENERATION_STATES.done!, previousRenders: [] }, campaignId: "c1", handlers, advancedHref: "#" })));
    expect(none).not.toContain("Versões anteriores");
  });

  it("\"Planejar de novo\" (?from=) só no modo local", () => {
    expect(screen()).not.toContain("/create?from=");
    expect(screen({ ...status, mode: "local", worker: { state: "local", lastSeenAt: null } })).toContain("/create?from=c1");
  });

  it("timeline: seleção acessível, cena vai para o MESMO player, sem regenerar/retry", () => {
    const html = screen();
    expect(html).toContain('role="tablist"');
    expect(html).toMatch(/role="tab"[^>]*aria-selected="true"/);
    expect(html).toContain("Ver no player");
    expect(text(html)).not.toMatch(/Regenerar|Tentar novamente/);
  });

  it("sem cotação de cena: falha de cena não ganha botão de retry por cena", () => {
    const failed = buildGenerationView(sourceFixture({ ...GENERATION_STATES.scene_failed!, jobQuote: { estimatedBrl: 3, ready: false } }), { creditsPerBrl: 100 });
    expect(failed.action).toBeNull();
  });

  it("em produção continua a experiência do L8.5 na mesma rota", () => {
    expect(withShell(createElement(GenerationScreen, { source: GENERATION_STATES.generating!, campaignId: "c1", handlers, advancedHref: "#" }))).not.toContain("data-result-studio");
  });
});

describe("fila × gerando na tela", () => {
  it("dado da fila: \"Seu vídeo está na fila\" (neutro) sem worker offline", () => {
    const v = buildGenerationView(GENERATION_STATES.queued!, { creditsPerBrl: 100 });
    expect(v).toMatchObject({ kind: "queued", headline: "Seu vídeo está na fila", tone: "neutral" });
    expect(v.subtext).toBe("O trabalho começa assim que o computador de geração assumir este projeto.");
  });
});
