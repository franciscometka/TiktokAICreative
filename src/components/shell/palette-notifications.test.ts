import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ShellStatus } from "@/app/api/shell/route";
import { groupItems, isPaletteShortcut, moveActive, PALETTE_ACTIONS, paletteItems, type PaletteData } from "@/application/command-palette";
import { addEvents, EMPTY_NOTIFICATIONS, markRead } from "@/application/notifications";
import { pushToast, ToastClock } from "../ds/toast-model";
import { PaletteView } from "./command-palette";
import { BellButton, NotificationList, NotificationsContext } from "./notification-center";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";
import { snapshotOf } from "./use-ux-events";

/** L8.8 — Command Palette, central de notificações, toasts e integração no shell. */

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const DATA: PaletteData = {
  projects: [{ id: "c1", name: "Secador Taiff", status: "ready", statusLabel: "Pronto" }, { id: "c2", name: "Fone Bluetooth", status: "generating", statusLabel: "Gerando" }],
  avatars: [{ id: "avatar_cris", name: "Cristina", active: true }],
};
const view = (query: string, active = 0) => renderToStaticMarkup(createElement(PaletteView, { query, onQuery: () => undefined, items: paletteItems(query, DATA), active, onActive: () => undefined, onPick: () => undefined, onKeyDown: () => undefined, listId: "pl", inputId: "pi" }));

describe("Command Palette", () => {
  it("busca vazia: ações rápidas + projetos recentes", () => {
    const items = paletteItems("", DATA);
    expect(items.slice(0, 5).map((i) => i.label)).toEqual(["Criar novo vídeo", "Criar avatar", "Abrir Projetos", "Abrir Avatares", "Abrir Créditos"]);
    expect(items.filter((i) => i.group === "Projetos recentes").map((i) => i.label)).toEqual(["Secador Taiff", "Fone Bluetooth"]);
  });

  it("busca filtra ações, projetos e avatares (sem acento); nada → vazio, sem sugestão falsa", () => {
    expect(paletteItems("secador", DATA).map((i) => i.href)).toEqual(["/campaigns/c1"]);
    expect(paletteItems("cristina", DATA).map((i) => i.href)).toEqual(["/avatars/avatar_cris"]);
    expect(paletteItems("creditos", DATA).map((i) => i.href)).toEqual(["/credits"]);
    expect(paletteItems("zzz", DATA)).toEqual([]);
    expect(text(view("zzz"))).toContain("Nada encontrado.");
  });

  it("só navegação/criação: nada destrutivo, de aprovação de gasto ou retry pago", () => {
    expect(PALETTE_ACTIONS.every((a) => a.href.startsWith("/"))).toBe(true);
    expect(JSON.stringify(PALETTE_ACTIONS)).not.toMatch(/excluir|arquivar|aprovar|autorizar|retry|tentar/i);
  });

  it("setas percorrem só itens (circular), Home/End; grupos não contam", () => {
    expect(moveActive(0, 3, "ArrowDown")).toBe(1);
    expect(moveActive(2, 3, "ArrowDown")).toBe(0);
    expect(moveActive(0, 3, "ArrowUp")).toBe(2);
    expect(moveActive(-1, 3, "ArrowDown")).toBe(0);
    expect(moveActive(1, 3, "End")).toBe(2);
    expect(moveActive(0, 0, "ArrowDown")).toBe(-1);
    const groups = groupItems(paletteItems("", DATA));
    expect(groups.map((g) => g.group)).toEqual(["Ações", "Projetos recentes"]);
    expect(groups[1]!.items[0]!.index).toBe(6);
  });

  it("Ctrl+K no Windows/Linux, ⌘K no macOS; outras combinações não", () => {
    expect(isPaletteShortcut({ key: "k", ctrlKey: true, metaKey: false }, false)).toBe(true);
    expect(isPaletteShortcut({ key: "K", ctrlKey: false, metaKey: true }, true)).toBe(true);
    expect(isPaletteShortcut({ key: "k", ctrlKey: false, metaKey: true }, false)).toBe(false);
    expect(isPaletteShortcut({ key: "k", ctrlKey: true, metaKey: false, shiftKey: true }, false)).toBe(false);
    expect(isPaletteShortcut({ key: "n", ctrlKey: true, metaKey: false }, false)).toBe(false);
  });

  it("acessível: combobox + listbox com aria-activedescendant e foco inicial no campo", () => {
    const html = view("", 1);
    expect(html).toMatch(/role="combobox"[^>]*aria-controls="pl"[^>]*aria-activedescendant="pl-1"/);
    expect(html).toContain('role="listbox"');
    expect(html).toMatch(/id="pl-1" role="option" aria-selected="true"/);
    expect(html).toContain("data-autofocus");
    expect(html).toContain('placeholder="O que você quer fazer?"');
  });
});

describe("Notificações", () => {
  const ev = (key: string, tone: "success" | "warning" = "success") => ({ key, kind: "project.completed" as const, tone, title: tone === "success" ? "Seu vídeo está pronto" : "Worker offline", description: "Secador Taiff · 35s", href: tone === "success" ? "/campaigns/c1" : null, actionLabel: tone === "success" ? "Ver resultado" : null, at: "2026-10-23T14:50:00Z" });

  it("vazia", () => {
    expect(text(renderToStaticMarkup(createElement(NotificationList, { state: EMPTY_NOTIFICATIONS, now: new Date(), onItem: () => undefined, onMarkAll: () => undefined })))).toContain("Nenhuma notificação ainda.");
  });

  it("preenchida: lista semântica, não lida com texto (não só cor), ação e marcar todas", () => {
    const state = markRead(addEvents(EMPTY_NOTIFICATIONS, [ev("a"), ev("b", "warning")]).state, "b");
    const html = renderToStaticMarkup(createElement(NotificationList, { state, now: new Date("2026-10-23T15:00:00Z"), onItem: () => undefined, onMarkAll: () => undefined }));
    const t = text(html);
    expect(html).toContain('<ul class="space-y-1.5" aria-label="Notificações">');
    for (const s of ["Seu vídeo está pronto", "Secador Taiff · 35s", "Ver resultado →", "Não lida", "Lida", "há 10 min", "1 não lida", "Marcar todas como lidas"]) expect(t).toContain(s);
    expect(html).toContain('href="/campaigns/c1"');
  });

  it("sino: contador de não lidas no rótulo acessível", () => {
    const state = addEvents(EMPTY_NOTIFICATIONS, [ev("a"), ev("b")]).state;
    const html = renderToStaticMarkup(createElement(NotificationsContext.Provider, { value: { state, open: false, setOpen: () => undefined, markRead: () => undefined, markAllRead: () => undefined } }, createElement(BellButton)));
    expect(html).toContain('aria-label="Notificações: 2 não lidas"');
    expect(html).toContain('data-bell="2"');
  });

  it("snapshot do shell para eventos usa só dados resumidos", () => {
    const status: ShellStatus = { mode: "cloud", worker: { state: "online", lastSeenAt: null }, user: null, credits: { creditsPerBrl: 100, remaining: 1800, allowance: 10_000, state: "low", estimatedVideos: null }, projects: [{ id: "c1", name: "S", status: "ready", statusLabel: "Pronto", durationLabel: "30s" }], avatars: [] };
    expect(snapshotOf(status)).toEqual({ worker: "online", credits: { state: "low", remaining: 1800, estimatedVideos: null }, projects: [{ id: "c1", name: "S", status: "ready", durationLabel: "30s" }] });
  });
});

describe("Toasts", () => {
  afterEach(() => vi.useRealTimers());

  it("dedupe por id (substitui) e no máximo 3", () => {
    let list = pushToast([], { id: "x", title: "A" }, "t1");
    list = pushToast(list, { id: "x", title: "B" }, "t2");
    expect(list.map((t) => t.title)).toEqual(["B"]);
    for (let i = 0; i < 4; i++) list = pushToast(list, { title: `n${i}` }, `f${i}`);
    expect(list).toHaveLength(3);
    expect(list.at(-1)!.tone).toBe("info");
  });

  it("some sozinho no tempo; hover/foco pausa e retoma com o tempo restante", () => {
    vi.useFakeTimers();
    let t = 0;
    const done = vi.fn();
    const clock = new ToastClock(5000, done, () => t);
    clock.start();
    vi.advanceTimersByTime(3000); t = 3000;
    clock.pause();
    vi.advanceTimersByTime(10_000); t = 13_000;
    expect(done).not.toHaveBeenCalled();
    clock.start();
    vi.advanceTimersByTime(1999);
    expect(done).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("ação do toast chama o callback (ex.: Ver resultado)", () => {
    const onClick = vi.fn();
    const [toast] = pushToast([], { id: "p", title: "✓ Seu vídeo está pronto", action: { label: "Ver resultado", onClick } }, "t");
    toast!.action!.onClick();
    expect(onClick).toHaveBeenCalled();
  });
});

describe("shell integrado", () => {
  const status: ShellStatus = { mode: "local", worker: { state: "local", lastSeenAt: null }, user: { label: "Modo local", initial: "L" }, credits: null };
  it("topbar: sino e palette funcionando (nada \"em breve\")", () => {
    const html = renderToStaticMarkup(createElement(Topbar, { pathname: "/", status, now: new Date(0), kbd: "Ctrl K", onOpenMenu: () => undefined, onOpenPalette: () => undefined }));
    expect(html).toContain('aria-label="Abrir Command Palette (Ctrl K)"');
    expect(html).toContain('aria-label="Notificações"');
    expect(html).toContain('aria-label="Buscar e ações"');
    expect(html).not.toMatch(/em breve|aria-disabled/);
  });
  it("sidebar: Command Palette é um botão real com o atalho", () => {
    const html = renderToStaticMarkup(createElement(Sidebar, { pathname: "/", status, now: new Date(0), kbd: "⌘K", onOpenPalette: () => undefined }));
    expect(html).toMatch(/<button type="button" aria-haspopup="dialog" data-open-palette[^>]*>[\s\S]*Command Palette[\s\S]*⌘K/);
    expect(html).not.toContain("Em breve");
  });
});
