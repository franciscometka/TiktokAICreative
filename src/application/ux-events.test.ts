import { describe, expect, it } from "vitest";
import { addEvents, EMPTY_NOTIFICATIONS, isSafeInternalHref, markAllRead, markRead, NOTIFICATION_LIMIT, notificationTime, parseNotifications, serializeNotifications, unreadCount } from "./notifications";
import { diffSnapshots, stepUx, toastFor, WORKER_NOTIFY, type UxEvent, type UxMemory, type UxSnapshot } from "./ux-events";

/** L8.8 / L8.8.1 — eventos de UX (memória, episódios, worker, créditos) e central de notificações. */

const NOW = new Date("2026-10-23T15:00:00Z");
const P1 = "2026-10-01T03:00:00.000Z";
const credits = (state: "normal" | "low" | "empty", remaining: number, over: Partial<NonNullable<UxSnapshot["credits"]>> = {}): NonNullable<UxSnapshot["credits"]> =>
  ({ state, remaining, allowance: 10_000, estimatedVideos: state === "low" ? { seconds: 30, count: 1, creditsPerVideo: 1500, basis: "estimate" } : null, periodStart: P1, ...over });
const snap = (over: Partial<UxSnapshot> = {}): UxSnapshot => ({
  worker: { state: "online", lastSeenAt: "2026-10-23T14:59:50Z" },
  credits: credits("normal", 8000),
  projects: [{ id: "c1", name: "Secador Taiff", status: "generating", durationLabel: "35s", episode: "at-1" }, { id: "c2", name: "Fone Pro", status: "queued", durationLabel: "30s", episode: "at-1" }],
  ...over,
});
const withProject = (id: string, status: UxSnapshot["projects"] extends readonly (infer P)[] | null ? P extends { status: infer S } ? S : never : never, episode = "at-2") =>
  snap().projects!.map((p) => (p.id === id ? { ...p, status, episode } : p));

/** Roda uma sequência de snapshots e junta todos os eventos. */
function run(seq: UxSnapshot[], start = NOW, stepMs = 30_000): UxEvent[] {
  let memory: UxMemory | null = null;
  const all: UxEvent[] = [];
  seq.forEach((s, i) => {
    const r = stepUx(memory, s, new Date(start.getTime() + i * stepMs));
    memory = r.memory;
    all.push(...r.events);
  });
  return all;
}

describe("baseline e transições", () => {
  it("primeiro load é baseline: nenhum evento, mesmo com projetos prontos, worker offline ou crédito baixo", () => {
    expect(stepUx(null, snap({ worker: { state: "offline", lastSeenAt: null }, credits: credits("low", 100), projects: [{ id: "c1", name: "X", status: "ready", durationLabel: "30s", episode: "render-r1" }] }), NOW).events).toEqual([]);
  });

  it("nada mudou → nenhum evento; poll repetido não repete", () => {
    expect(run([snap(), snap(), snap()])).toEqual([]);
    expect(run([snap(), snap({ projects: withProject("c1", "ready", "render-r1") }), snap({ projects: withProject("c1", "ready", "render-r1") })])).toHaveLength(1);
  });

  it("pronto: chave com a versão do render (do servidor)", () => {
    const [e] = diffSnapshots(snap(), snap({ projects: withProject("c1", "ready", "render-r1") }), NOW);
    expect(e).toMatchObject({ key: "project:c1:completed:render-r1", title: "Seu vídeo está pronto", description: "Secador Taiff · 35s", href: "/campaigns/c1", actionLabel: "Ver resultado" });
  });

  it("pronto v1 → novo processamento → pronto v2 = 2 eventos (também sem ver o meio)", () => {
    const events = run([snap(), snap({ projects: withProject("c1", "ready", "render-r1") }), snap({ projects: withProject("c1", "generating", "at-5") }), snap({ projects: withProject("c1", "ready", "render-r2") })]);
    expect(events.filter((e) => e.kind === "project.completed").map((e) => e.key)).toEqual(["project:c1:completed:render-r1", "project:c1:completed:render-r2"]);
    expect(run([snap(), snap({ projects: withProject("c1", "ready", "render-r1") }), snap({ projects: withProject("c1", "ready", "render-r2") })])).toHaveLength(2);
  });

  it("falhou → recuperou → falhou de novo = 2 eventos (episódios diferentes)", () => {
    const events = run([snap(), snap({ projects: withProject("c1", "failed", "at-2") }), snap({ projects: withProject("c1", "generating", "at-3") }), snap({ projects: withProject("c1", "failed", "at-4") })]);
    expect(events.map((e) => e.key)).toEqual(["project:c1:failed:at-2", "project:c1:failed:at-4"]);
  });

  it("aprovação, pausa por segurança; projeto novo e simulação não notificam", () => {
    expect(diffSnapshots(snap(), snap({ projects: withProject("c2", "awaiting_approval") }), NOW)[0]).toMatchObject({ kind: "project.needs_approval", key: "project:c2:needs-approval:at-2" });
    expect(diffSnapshots(snap(), snap({ projects: withProject("c1", "blocked") }), NOW)[0]).toMatchObject({ title: "Geração pausada por segurança" });
    expect(diffSnapshots(snap(), snap({ projects: [...snap().projects!, { id: "c3", name: "Novo", status: "awaiting_approval", durationLabel: null, episode: "at-1" }] }), NOW)).toEqual([]);
    expect(diffSnapshots(snap(), snap({ projects: withProject("c1", "simulated", "render-m1") }), NOW)).toEqual([]);
  });

  it("projetos não consultados (null) mantêm os anteriores: a transição seguinte ainda é vista", () => {
    expect(run([snap(), snap({ projects: null }), snap({ projects: withProject("c1", "ready", "render-r1") })]).map((e) => e.kind)).toEqual(["project.completed"]);
  });
});

describe("worker: episódios, cooldown e confirmação", () => {
  const w = (state: "online" | "offline" | "unknown", lastSeenAt = "2026-10-23T14:59:50Z") => snap({ worker: { state, lastSeenAt } });

  it("online → offline = 1 aviso (chave = último heartbeat do servidor); recuperação só confirmada", () => {
    const events = run([w("online"), w("offline"), w("online"), w("online")]);
    expect(events.map((e) => e.kind)).toEqual(["worker.offline", "worker.online"]);
    expect(events[0]!.key).toBe("worker:offline:2026-10-23T14:59:50Z");
    expect(WORKER_NOTIFY.confirmOnlinePolls).toBe(2);
  });

  it("flapping numa janela curta: no máximo 1 queda e 1 recuperação", () => {
    const events = run([w("online"), w("offline"), w("online"), w("offline"), w("online"), w("offline"), w("online"), w("online"), w("offline"), w("online"), w("online")]);
    expect(events.filter((e) => e.kind === "worker.offline")).toHaveLength(1);
    expect(events.filter((e) => e.kind === "worker.online")).toHaveLength(1);
  });

  it("depois do cooldown, uma nova queda volta a avisar", () => {
    const events = run([w("online"), w("offline"), w("online"), w("online"), w("offline", "2026-10-23T15:20:00Z")], NOW, WORKER_NOTIFY.cooldownMs);
    expect(events.filter((e) => e.kind === "worker.offline")).toHaveLength(2);
  });

  it("unknown é silencioso (para e a partir dele)", () => {
    expect(run([w("unknown"), w("online"), w("unknown"), w("offline")])).toEqual([]);
  });
});

describe("créditos: último valor válido e episódios", () => {
  const c = (x: UxSnapshot["credits"]) => snap({ credits: x });

  it("normal → erro (null) → low / zero: o aviso não se perde", () => {
    expect(run([c(credits("normal", 8000)), c(null), c(credits("low", 1820))]).map((e) => e.kind)).toEqual(["credits.low"]);
    expect(run([c(credits("normal", 8000)), c(null), c(credits("empty", 0))]).map((e) => e.kind)).toEqual(["credits.empty"]);
  });

  it("low → erro → normal: sem aviso; descrição com equivalência só quando confiável", () => {
    expect(run([c(credits("low", 1500)), c(null), c(credits("normal", 9000, { allowance: 20_000 }))])).toEqual([]);
    const [low] = run([c(credits("normal", 8000)), c(credits("low", 1820))]);
    expect(low!.description).toBe("Restam 1.820 créditos neste mês. ≈ 1 vídeo de 30s");
  });

  it("mês novo vira referência (sem aviso retroativo)", () => {
    expect(run([c(credits("low", 1500)), c(credits("normal", 10_000, { periodStart: "2026-11-01T03:00:00.000Z" }))])).toEqual([]);
  });

  it("segundo cruzamento legítimo (franquia aumentou) gera novo evento; reload sem mudança não", () => {
    const events = run([c(credits("normal", 8000)), c(credits("low", 1820)), c(credits("normal", 11_820, { allowance: 20_000 })), c(credits("low", 3000, { allowance: 20_000 }))]);
    expect(events.map((e) => e.key)).toEqual([`credits:low:${P1}:10000`, `credits:low:${P1}:20000`]);
    // Reload = nova memória (baseline): nada.
    expect(stepUx(null, c(credits("low", 3000, { allowance: 20_000 })), NOW).events).toEqual([]);
  });
});

describe("toast × central", () => {
  it("concluído vira toast só fora da página do projeto; aprovação fica só na central", () => {
    const [done] = diffSnapshots(snap(), snap({ projects: withProject("c1", "ready", "render-r1") }), NOW);
    expect(toastFor(done!, "/projects")).toBe(true);
    expect(toastFor(done!, "/campaigns/c1")).toBe(false);
    const [approval] = diffSnapshots(snap(), snap({ projects: withProject("c2", "awaiting_approval") }), NOW);
    expect(toastFor(approval!, "/")).toBe(false);
  });
});

const event = (key: string, over: Partial<UxEvent> = {}): UxEvent => ({ key, kind: "project.completed", tone: "success", title: "Seu vídeo está pronto", description: "X", href: "/campaigns/x", actionLabel: "Ver resultado", at: NOW.toISOString(), ...over });

describe("central de notificações", () => {
  it("dedupe: o mesmo evento entra uma vez só", () => {
    let { state, added } = addEvents(EMPTY_NOTIFICATIONS, [event("project:c1:completed:r1")]);
    expect(added).toHaveLength(1);
    ({ state, added } = addEvents(state, [event("project:c1:completed:r1"), event("project:c1:completed:r1")]));
    expect(added).toHaveLength(0);
    expect(state.items).toHaveLength(1);
  });

  it("lido, marcar todas, contador", () => {
    let { state } = addEvents(EMPTY_NOTIFICATIONS, [event("a"), event("b"), event("c")]);
    expect(unreadCount(state)).toBe(3);
    state = markRead(state, "b");
    expect(unreadCount(state)).toBe(2);
    expect(unreadCount(markAllRead(state))).toBe(0);
  });

  it("limite de 50; chave que saiu da lista não volta", () => {
    let state = EMPTY_NOTIFICATIONS;
    for (let i = 0; i < 60; i++) state = addEvents(state, [event(`k${i}`, { at: new Date(NOW.getTime() + i * 1000).toISOString() })]).state;
    expect(state.items).toHaveLength(NOTIFICATION_LIMIT);
    expect(state.items[0]!.key).toBe("k59");
    expect(addEvents(state, [event("k0")]).added).toHaveLength(0);
  });

  it("persistência: ida e volta; corrompido ou link inseguro é descartado", () => {
    const { state } = addEvents(EMPTY_NOTIFICATIONS, [event("a")]);
    expect(parseNotifications(serializeNotifications(markRead(state, "a")))).toMatchObject({ items: [{ key: "a", read: true }], seen: ["a"] });
    expect(parseNotifications("{not json")).toEqual(EMPTY_NOTIFICATIONS);
    for (const href of ["//evil.com", "https://evil.example", "/\\evil"]) expect(parseNotifications(JSON.stringify({ items: [event("x", { href })] })).items).toEqual([]);
  });

  it("links internos: só rota interna segura", () => {
    for (const ok of ["/projects", "/projects/abc", "/avatars/abc", "/campaigns/c1?view=advanced", "/credits"]) expect(isSafeInternalHref(ok)).toBe(true);
    for (const bad of ["//evil.com", "/\\evil", "\\\\evil", "https://evil.com", "javascript:alert(1)", "/%2F%2Fevil.com", "/%5Cevil", "/proj\u0000ects", "/a\nb", "/a b", "", "projects", null, 42]) expect(isSafeInternalHref(bad)).toBe(false);
  });

  it("horário relativo", () => {
    expect(notificationTime("2026-10-23T14:59:30Z", NOW)).toBe("agora");
    expect(notificationTime("2026-10-23T14:50:00Z", NOW)).toBe("há 10 min");
    expect(notificationTime("2026-10-22T12:00:00Z", NOW)).toBe("ontem");
  });
});
