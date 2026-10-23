import { describe, expect, it } from "vitest";
import { addEvents, EMPTY_NOTIFICATIONS, markAllRead, markRead, NOTIFICATION_LIMIT, notificationTime, parseNotifications, serializeNotifications, unreadCount } from "./notifications";
import { creditsPeriodKey, diffSnapshots, toastFor, type UxEvent, type UxSnapshot } from "./ux-events";

/** L8.8 — eventos de UX (transições puras) e central de notificações (dedupe, lido, limite, persistência). */

const NOW = new Date("2026-10-23T15:00:00Z");
const snap = (over: Partial<UxSnapshot> = {}): UxSnapshot => ({
  worker: "online",
  credits: { state: "normal", remaining: 8000, estimatedVideos: { seconds: 30, count: 3, creditsPerVideo: 2272, basis: "estimate" } },
  projects: [{ id: "c1", name: "Secador Taiff", status: "generating", durationLabel: "35s" }, { id: "c2", name: "Fone Pro", status: "queued", durationLabel: "30s" }],
  ...over,
});
const withProject = (id: string, status: UxSnapshot["projects"][number]["status"]) => snap().projects.map((p) => (p.id === id ? { ...p, status } : p));

describe("transições → eventos", () => {
  it("primeiro load é baseline: nenhum evento, mesmo com projetos prontos", () => {
    expect(diffSnapshots(null, snap({ projects: [{ id: "c1", name: "X", status: "ready", durationLabel: "30s" }] }), NOW)).toEqual([]);
  });

  it("nada mudou → nenhum evento", () => {
    expect(diffSnapshots(snap(), snap(), NOW)).toEqual([]);
  });

  it("gerando → pronto = project.completed com chave estável e ação", () => {
    const [e] = diffSnapshots(snap(), snap({ projects: withProject("c1", "ready") }), NOW);
    expect(e).toMatchObject({ key: "project:c1:completed", kind: "project.completed", tone: "success", title: "Seu vídeo está pronto", description: "Secador Taiff · 35s", href: "/campaigns/c1", actionLabel: "Ver resultado" });
  });

  it("em produção → aguardando aprovação; e → atenção/falha/pausa", () => {
    expect(diffSnapshots(snap(), snap({ projects: withProject("c2", "awaiting_approval") }), NOW)[0]).toMatchObject({ kind: "project.needs_approval", title: "Seu projeto precisa da sua aprovação", key: "project:c2:needs-approval:queued" });
    expect(diffSnapshots(snap(), snap({ projects: withProject("c1", "blocked") }), NOW)[0]).toMatchObject({ kind: "project.attention", title: "Geração pausada por segurança", tone: "warning" });
    expect(diffSnapshots(snap(), snap({ projects: withProject("c1", "failed") }), NOW)[0]).toMatchObject({ kind: "project.attention", tone: "danger" });
  });

  it("projeto novo (criado agora) não notifica", () => {
    const next = snap({ projects: [...snap().projects, { id: "c3", name: "Novo", status: "awaiting_approval", durationLabel: null }] });
    expect(diffSnapshots(snap(), next, NOW)).toEqual([]);
  });

  it("worker: online→offline (warning) e offline→online (success); unknown não alerta", () => {
    expect(diffSnapshots(snap(), snap({ worker: "offline" }), NOW)[0]).toMatchObject({ kind: "worker.offline", tone: "warning" });
    expect(diffSnapshots(snap({ worker: "offline" }), snap(), NOW)[0]).toMatchObject({ kind: "worker.online", tone: "success" });
    expect(diffSnapshots(snap({ worker: "unknown" }), snap({ worker: "online" }), NOW)).toEqual([]);
    expect(diffSnapshots(snap(), snap({ worker: "unknown" }), NOW)).toEqual([]);
  });

  it("créditos: só ao cruzar o limiar (low ≤ 20%, zero), com equivalência quando confiável", () => {
    const low = { state: "low" as const, remaining: 1820, estimatedVideos: { seconds: 30 as const, count: 1, creditsPerVideo: 1500, basis: "estimate" as const } };
    const [e] = diffSnapshots(snap(), snap({ credits: low }), NOW);
    expect(e).toMatchObject({ key: `credits:low:${creditsPeriodKey(NOW)}`, title: "Seus créditos estão baixos", description: "Restam 1.820 créditos neste mês. ≈ 1 vídeo de 30s" });
    expect(diffSnapshots(snap({ credits: low }), snap({ credits: { ...low, remaining: 1500 } }), NOW)).toEqual([]);
    expect(diffSnapshots(snap({ credits: low }), snap({ credits: { state: "empty", remaining: 0, estimatedVideos: null } }), NOW)[0]).toMatchObject({ kind: "credits.empty", tone: "danger" });
    expect(diffSnapshots(snap(), snap({ credits: { ...low, estimatedVideos: null } }), NOW)[0]!.description).toBe("Restam 1.820 créditos neste mês.");
  });

  it("toast × central: concluído vira toast só fora da página do projeto; aprovação fica só na central", () => {
    const [done] = diffSnapshots(snap(), snap({ projects: withProject("c1", "ready") }), NOW);
    expect(toastFor(done!, "/projects")).toBe(true);
    expect(toastFor(done!, "/campaigns/c1")).toBe(false);
    const [approval] = diffSnapshots(snap(), snap({ projects: withProject("c2", "awaiting_approval") }), NOW);
    expect(toastFor(approval!, "/")).toBe(false);
  });
});

const event = (key: string, over: Partial<UxEvent> = {}): UxEvent => ({ key, kind: "project.completed", tone: "success", title: "Seu vídeo está pronto", description: "X", href: "/campaigns/x", actionLabel: "Ver resultado", at: NOW.toISOString(), ...over });

describe("central de notificações", () => {
  it("dedupe: o mesmo evento (polls repetidos) entra uma vez só", () => {
    let { state, added } = addEvents(EMPTY_NOTIFICATIONS, [event("project:c1:completed")]);
    expect(added).toHaveLength(1);
    ({ state, added } = addEvents(state, [event("project:c1:completed"), event("project:c1:completed")]));
    expect(added).toHaveLength(0);
    expect(state.items).toHaveLength(1);
  });

  it("lido, marcar todas, contador de não lidas", () => {
    let { state } = addEvents(EMPTY_NOTIFICATIONS, [event("a"), event("b"), event("c")]);
    expect(unreadCount(state)).toBe(3);
    state = markRead(state, "b");
    expect(unreadCount(state)).toBe(2);
    expect(state.items.find((n) => n.key === "b")!.read).toBe(true);
    expect(unreadCount(markAllRead(state))).toBe(0);
  });

  it("limite: só as 50 mais novas; chave que saiu da lista não volta", () => {
    let state = EMPTY_NOTIFICATIONS;
    for (let i = 0; i < 60; i++) state = addEvents(state, [event(`k${i}`)]).state;
    expect(state.items).toHaveLength(NOTIFICATION_LIMIT);
    expect(state.items[0]!.key).toBe("k59");
    expect(addEvents(state, [event("k0")]).added).toHaveLength(0);
  });

  it("persistência no navegador: ida e volta; dado corrompido ou link externo é descartado", () => {
    const { state } = addEvents(EMPTY_NOTIFICATIONS, [event("a")]);
    expect(parseNotifications(serializeNotifications(markRead(state, "a")))).toMatchObject({ items: [{ key: "a", read: true }], seen: ["a"] });
    expect(parseNotifications("{not json")).toEqual(EMPTY_NOTIFICATIONS);
    expect(parseNotifications(null)).toEqual(EMPTY_NOTIFICATIONS);
    expect(parseNotifications(JSON.stringify({ items: [{ ...event("evil"), href: "https://evil.example" }] })).items).toEqual([]);
  });

  it("horário relativo", () => {
    expect(notificationTime("2026-10-23T14:59:30Z", NOW)).toBe("agora");
    expect(notificationTime("2026-10-23T14:50:00Z", NOW)).toBe("há 10 min");
    expect(notificationTime("2026-10-23T12:00:00Z", NOW)).toBe("há 3 h");
    expect(notificationTime("2026-10-22T12:00:00Z", NOW)).toBe("ontem");
  });
});
