import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { lastSeenLabel, workerStatusCopy, workerStatusFrom, type WorkerStatusView } from "@/application/worker-status";
import { BottomNav } from "./bottom-nav";
import { CreditsBadge } from "./credits-badge";
import { isActive, NAV_MAIN, pageTitle } from "./nav";
import { Sidebar } from "./sidebar";
import { WorkerStatus } from "./worker-status";

/** L8.1 — shell: navegação, aria-current, worker (online/offline/unknown/local) e créditos. */

const NOW = new Date("2026-10-22T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const status = (worker: WorkerStatusView) => ({ mode: "cloud" as const, worker, user: { label: "cisco", initial: "C" } });
const currentLinks = (html: string) => [...html.matchAll(/<a[^>]*aria-current="page"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, ""));

describe("navegação", () => {
  it("rota ativa e título da topbar", () => {
    expect(isActive("/campaigns/abc", "/projects")).toBe(true);
    expect(isActive("/", "/")).toBe(true);
    expect(isActive("/create", "/")).toBe(false);
    expect(pageTitle("/campaigns/campaign_x")).toBe("Projeto");
    expect(pageTitle("/avatars/new")).toBe("Novo avatar");
    expect(pageTitle("/avatars/av_1")).toBe("Avatares");
    expect(pageTitle("/rota-desconhecida")).toBe("Creative Factory");
  });

  it("sidebar desktop: marca, seções e exatamente um item com aria-current", () => {
    const html = renderToStaticMarkup(createElement(Sidebar, { pathname: "/campaigns/abc", status: status({ state: "online", lastSeenAt: ago(5_000) }), now: NOW, kbd: "Ctrl K" }));
    for (const text of ["Creative Factory", "AI Video Studio", "Início", "Criar vídeo", "Projetos", "Avatares", "Créditos", "Command Palette", "Configurações", "Ctrl K", "cisco"]) expect(html).toContain(text);
    expect(currentLinks(html)).toEqual(["Projetos"]);
    // Itens ainda não implementados não são links (sem botão morto).
    expect(html).not.toMatch(/<a[^>]*>[^<]*Créditos/);
    expect(html).toMatch(/aria-disabled="true"[^>]*>[\s\S]*?Créditos/);
  });

  it("bottom nav mobile: 4 áreas, Criar em destaque, aria-current na rota", () => {
    const html = renderToStaticMarkup(createElement(BottomNav, { pathname: "/create" }));
    expect(NAV_MAIN.map((n) => n.short)).toEqual(["Início", "Criar", "Projetos", "Avatares"]);
    for (const label of ["Início", "Criar", "Projetos", "Avatares"]) expect(html).toContain(label);
    expect(html).toContain("data-create");
    expect(currentLinks(html)).toEqual(["✦Criar"]);
    expect(html).toContain('aria-label="Navegação principal"');
  });
});

describe("worker status", () => {
  it("online: rótulo, tooltip com último contato", () => {
    const html = renderToStaticMarkup(createElement(WorkerStatus, { status: { state: "online", lastSeenAt: ago(10_000) }, now: NOW }));
    for (const text of ["Worker online", "Worker conectado", "Pronto para gerar vídeos", "Último contato: agora"]) expect(html).toContain(text);
    expect(html).toContain('role="tooltip"');
  });

  it("offline: mensagem tranquilizadora (fila preservada)", () => {
    const html = renderToStaticMarkup(createElement(WorkerStatus, { variant: "panel", status: workerStatusFrom(ago(10 * 60_000), NOW), now: NOW }));
    for (const text of ["Worker offline", "Seu computador de geração está offline.", "Os projetos continuam na fila", "há 10 min"]) expect(html).toContain(text);
  });

  it("unknown NÃO é offline", () => {
    const html = renderToStaticMarkup(createElement(WorkerStatus, { variant: "panel", status: workerStatusFrom(null, NOW), now: NOW }));
    expect(html).toContain("Worker não verificado");
    expect(html).not.toContain("offline");
  });

  it("local e carregando (placeholder sem texto de status)", () => {
    expect(renderToStaticMarkup(createElement(WorkerStatus, { status: { state: "local", lastSeenAt: null }, now: NOW }))).toContain("Geração local");
    const loading = renderToStaticMarkup(createElement(WorkerStatus, { status: null }));
    expect(loading).not.toMatch(/online|offline|verificado/);
  });

  it("textos e rótulos de tempo", () => {
    expect(lastSeenLabel(ago(30_000), NOW)).toBe("agora");
    expect(lastSeenLabel(ago(3 * 60_000), NOW)).toBe("há 3 min");
    expect(lastSeenLabel(ago(2 * 3600_000), NOW)).toBe("há 2 h");
    expect(lastSeenLabel(ago(26 * 3600_000), NOW)).toBe("há 1 dia");
    expect(workerStatusFrom("não é data", NOW).state).toBe("unknown");
    expect(workerStatusCopy({ state: "offline", lastSeenAt: null }, NOW).lines.join(" ")).not.toContain("Último contato");
  });
});

describe("créditos (até o L8.2)", () => {
  it("badge reservado, sem nenhum número", () => {
    const html = renderToStaticMarkup(createElement(CreditsBadge));
    expect(html).toContain("Créditos");
    expect(html.replace(/<[^>]+>/g, "")).not.toMatch(/\d/);
  });
});
