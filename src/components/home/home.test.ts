import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createHref, dayPeriod, greeting, HOME_RECENT_LIMIT, homeStats, recentProjects, trustedDisplayName } from "@/application/home-view";
import { PROJECT_STATUS_LABELS, type ProjectCard } from "@/application/project-v2-view";
import { STYLE_PRESETS } from "@/application/style-presets";
import { isDarkRoute } from "../shell/nav";
import { ShellStatusContext } from "../shell/shell-status-context";
import { PhotoDropView } from "../upload/photo-drop";
import { screenFiles } from "../upload/upload-client";
import { HomeScreen, MiniDashboard, WorkerStat } from "./home-screen";
import { RecentProjects } from "./recent-projects";

/** L8.3 — Home Cinematic: saudação, nome, composer → Create, upload, mini dashboard e recentes. */

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const card = (i: number, over: Partial<ProjectCard> = {}): ProjectCard => ({
  id: `c${i}`, name: `Projeto ${i}`, productName: `Produto ${i}`, thumbnailUrl: `/api/uploads/p${i}/img_${i}.png`, thumbnailKind: "product", avatarName: "Cristina", durationLabel: "30s", actualBrl: null, estimatedBrl: null,
  status: "ready", statusLabel: "Pronto", createdAt: `2026-10-${String(10 + i).padStart(2, "0")}T12:00:00Z`, dateLabel: "x", ...over,
});
const NOW = new Date("2026-10-23T12:00:00Z");
const home = (over: Partial<Parameters<typeof HomeScreen>[0]> = {}) => renderToStaticMarkup(createElement(HomeScreen, { name: null, productId: "prod_1", stats: [], recent: [], ...over }));

describe("saudação e nome", () => {
  it("período pela hora local do navegador", () => {
    expect([dayPeriod(5), dayPeriod(11), dayPeriod(12), dayPeriod(17), dayPeriod(18), dayPeriod(2)]).toEqual(["morning", "morning", "afternoon", "afternoon", "evening", "evening"]);
    expect(greeting("morning", "Ana")).toBe("Bom dia, Ana");
    expect(greeting("afternoon", "Ana")).toBe("Boa tarde, Ana");
    expect(greeting("evening", "Ana")).toBe("Boa noite, Ana");
  });

  it("servidor não adivinha o período: render inicial com nome = \"Olá, Ana\" (sem mismatch)", () => {
    expect(greeting(null, "Ana")).toBe("Olá, Ana");
    const t = text(home({ name: "Ana" }));
    expect(t).toContain("Olá, Ana");
    expect(t).not.toMatch(/Bom dia|Boa tarde|Boa noite/);
  });

  it("sem nome (e no modo local): \"Olá. ✦\"", () => {
    expect(greeting("afternoon", null)).toBe("Olá.");
    const t = text(home());
    expect(t).toContain("Olá. ✦");
    expect(t).toContain("Transforme um produto em conteúdo que vende.");
  });

  it("nome só de user_metadata confiável; e-mail nunca vira nome", () => {
    expect(trustedDisplayName({ user_metadata: { full_name: "Francisco Metka" } })).toBe("Francisco");
    expect(trustedDisplayName({ user_metadata: { name: "Ana" } })).toBe("Ana");
    expect(trustedDisplayName({ email: "francisco@example.com" })).toBeNull();
    expect(trustedDisplayName({ user_metadata: { full_name: "francisco@example.com" } })).toBeNull();
    expect(trustedDisplayName({ user_metadata: { email: "ana@x.com", full_name: "  " } })).toBeNull();
    expect(trustedDisplayName({ user_metadata: { full_name: "12345" } })).toBeNull();
    expect(trustedDisplayName(null)).toBeNull();
  });

  it("Home é dark nativa (fora da ilha clara) sem escurecer as outras rotas", () => {
    expect(isDarkRoute("/")).toBe(true);
    expect(isDarkRoute("/avatars")).toBe(false);
    expect(isDarkRoute("/credits")).toBe(true);
  });
});

describe("composer → Create", () => {
  it("foto + campo de ideia + presets + CTA ✦ Criar vídeo para /create (Home não cria projeto)", () => {
    const html = home();
    const t = text(html);
    expect(html).toContain('placeholder="Conte o que você quer criar..."');
    for (const p of ["UGC de produto", "Apresentação", "Oferta rápida", "Demonstração"]) expect(t).toContain(p);
    expect(html).toMatch(/data-home-cta="true" href="\/create\?preset=natural"/);
    expect(t).toContain("✦ Criar vídeo");
    expect(html).toContain('aria-pressed="true"');
    expect(html).not.toContain("<form");
  });

  it("link leva foto, ideia e preset (o Create revalida)", () => {
    const href = createHref({ productId: "prod_1", imageId: "img_abc.png", idea: "  Mulher no quarto  ", preset: "demo" });
    const params = new URL(href, "http://x").searchParams;
    expect(href.startsWith("/create?")).toBe(true);
    expect(Object.fromEntries(params)).toEqual({ product: "prod_1", image: "img_abc.png", idea: "Mulher no quarto", preset: "demo" });
    expect(createHref({ productId: "prod_1" })).toBe("/create");
    expect(createHref({ preset: "nope" as never })).toBe("/create");
  });

  it("presets só preenchem campos existentes (tom, CTA, duração)", () => {
    expect(STYLE_PRESETS).toHaveLength(4);
    for (const p of STYLE_PRESETS) {
      expect(Object.keys(p).sort()).toEqual(["cta", "description", "duration", "homeLabel", "id", "label", "tone"]);
      expect([30, 45, 60]).toContain(p.duration);
    }
  });
});

describe("upload compartilhado", () => {
  const view = (state: Parameters<typeof PhotoDropView>[0]["state"], over: Partial<Parameters<typeof PhotoDropView>[0]> = {}) =>
    renderToStaticMarkup(createElement(PhotoDropView, { state, images: [], max: 1, ...over }));

  it("idle e drag: botão acessível por teclado/clique", () => {
    expect(view("idle")).toMatch(/<button type="button"[^>]*>.*Foto do produto/);
    expect(text(view("drag"))).toContain("Solte para enviar");
  });

  it("uploading: skeleton + texto, sem porcentagem", () => {
    const html = view("uploading", { message: "Enviando foto…" });
    expect(text(html)).toContain("Enviando foto…");
    expect(html).toContain("animate-shimmer");
    expect(text(html)).not.toMatch(/\d+\s?%/);
    expect(html).not.toContain('role="progressbar"');
  });

  it("success: imagem com reveal e check; error anunciado por aria-live", () => {
    const ok = view("success", { images: [{ id: "img_1.png", previewUrl: "/api/uploads/p/img_1.png" }], onRemove: () => undefined });
    expect(ok).toContain('src="/api/uploads/p/img_1.png"');
    expect(ok).toContain("animate-reveal");
    expect(text(ok)).toContain("Imagem pronta");
    expect(ok).toContain('aria-label="Remover foto"');
    const err = view("error", { message: "foto.gif: Formato não suportado." });
    expect(err).toMatch(/aria-live="polite"[^>]*>foto\.gif: Formato não suportado\./);
  });

  it("triagem: tipo, tamanho e limite antes de enviar", () => {
    const r = screenFiles([{ name: "a.png", type: "image/png", size: 10 }, { name: "b.gif", type: "image/gif", size: 10 }, { name: "c.png", type: "image/png", size: 10 }], 1);
    expect(r.accepted).toEqual([0]);
    expect(r.problems.join(" ")).toMatch(/b\.gif/);
    expect(r.problems.length).toBe(2);
  });
});

describe("mini dashboard", () => {
  const withShell = (status: unknown, child: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(ShellStatusContext.Provider, { value: { status: status as never, now: NOW } }, child));

  it("créditos e vídeos reais; não configurado → omitidos (nunca 0 inventado)", () => {
    const stats = homeStats({ credits: { videosGenerated: 3, remaining: 7728 }, activeAvatars: 2 });
    expect(stats.map((s) => [s.id, s.value])).toEqual([["videos", 3], ["credits", 7728], ["avatars", 2]]);
    const t = text(withShell(null, createElement(MiniDashboard, { stats })));
    for (const s of ["Vídeos este mês", "3", "Créditos disponíveis", "7.728", "Avatares ativos"]) expect(t).toContain(s);
    expect(homeStats({ credits: null, activeAvatars: 1 }).map((s) => s.id)).toEqual(["avatars"]);
  });

  it("worker do status do shell: online, offline, não verificado, local; carregando = skeleton", () => {
    for (const [state, label] of [["online", "Worker online"], ["offline", "Worker offline"], ["unknown", "Worker não verificado"], ["local", "Geração local"]] as const) {
      const html = renderToStaticMarkup(createElement(WorkerStat, { worker: { state, lastSeenAt: null }, now: NOW }));
      expect(text(html)).toContain(label);
      expect(html).toContain(`data-worker-state="${state}"`);
    }
    const loading = withShell(null, createElement(MiniDashboard, { stats: [] }));
    expect(loading).toContain("animate-shimmer");
    const fromShell = withShell({ mode: "cloud", worker: { state: "offline", lastSeenAt: null }, user: null, credits: null }, createElement(MiniDashboard, { stats: [] }));
    expect(text(fromShell)).toContain("Worker offline");
  });
});

describe("projetos recentes", () => {
  it("exatamente os 4 mais recentes, status reais, sem progresso falso nem vídeo no hover", () => {
    const recent = recentProjects([1, 2, 3, 4, 5, 6].map((i) => card(i)));
    expect(HOME_RECENT_LIMIT).toBe(4);
    expect(recent.map((c) => c.id)).toEqual(["c6", "c5", "c4", "c3"]);
    const html = renderToStaticMarkup(createElement(RecentProjects, { cards: [...recent.slice(0, 3), card(9, { status: "awaiting_approval", statusLabel: PROJECT_STATUS_LABELS.awaiting_approval })] }));
    expect(html).toContain('data-recent-count="4"');
    expect(text(html)).toContain("Aguardando aprovação");
    expect(text(html)).not.toContain("Aguardando você");
    expect(text(html)).toContain("Cristina · 30s");
    expect(html).not.toMatch(/<video|role="progressbar"/);
    expect(html).toContain('href="/campaigns/c6"');
  });

  it("vazio: \"Seu estúdio está pronto.\"", () => {
    const t = text(renderToStaticMarkup(createElement(RecentProjects, { cards: [] })));
    expect(t).toContain("Seu estúdio está pronto.");
    expect(t).toContain("Crie seu primeiro vídeo com IA.");
  });
});
