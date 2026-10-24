import { describe, expect, it, vi } from "vitest";
import { isEditableTarget, paletteItems, resolveActive, type PaletteData } from "@/application/command-palette";
import type { ShellSummary } from "@/application/shell-summary";
import { buildShellStatus, notificationNamespace } from "@/server/shell-status";
import { LatestOnly } from "./latest-only";

/** L8.8.1 — polling "só o último vale", atalho em campos, seleção da palette e /api/shell leve e isolado. */

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("polling fora de ordem", () => {
  it("A começa, B começa depois, B resolve primeiro, A depois → fica B (A é abortada e descartada)", async () => {
    const a = deferred<string>();
    const b = deferred<string>();
    const signals: AbortSignal[] = [];
    const queue = [a, b];
    const seen: string[] = [];
    const poller = new LatestOnly<string>((signal) => { signals.push(signal); return queue.shift()!.promise; }, (v) => seen.push(v));
    const pa = poller.load();
    const pb = poller.load();
    expect(signals[0]!.aborted).toBe(true); // a nova leitura cancela a anterior (sem duas valendo)
    b.resolve("B");
    await pb;
    a.resolve("A"); // fetch que ignora o abort
    await pa;
    expect(seen).toEqual(["B"]);
  });

  it("erro mantém o último valor; depois de stop nada é aplicado", async () => {
    const seen: string[] = [];
    let n = 0;
    const poller = new LatestOnly<string>(async () => { n++; if (n === 2) throw new Error("rede"); return `v${n}`; }, (v) => seen.push(v));
    await poller.load();
    await poller.load();
    expect(seen).toEqual(["v1"]);
    const late = deferred<string>();
    const p2 = new LatestOnly<string>(() => late.promise, (v) => seen.push(v));
    const run = p2.load();
    p2.stop();
    late.resolve("tarde");
    await run;
    expect(seen).toEqual(["v1"]);
  });
});

describe("Ctrl/⌘K em campos e seleção da palette", () => {
  it("isEditableTarget: input/textarea/select/contenteditable; campo da palette é exceção", () => {
    const el = (tagName: string, extra: Record<string, unknown> = {}) => ({ tagName, closest: () => null, ...extra });
    for (const t of ["INPUT", "textarea", "SELECT"]) expect(isEditableTarget(el(t))).toBe(true);
    expect(isEditableTarget(el("DIV", { isContentEditable: true }))).toBe(true);
    expect(isEditableTarget(el("BUTTON"))).toBe(false);
    expect(isEditableTarget(el("INPUT", { closest: (s: string) => (s === "[data-palette]" ? {} : null) }))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });

  it("dataset encolhe com a MESMA busca: a seleção efetiva cai num item que existe (Enter = destacado)", () => {
    const big: PaletteData = { projects: [{ id: "p1", name: "Secador A", status: "ready", statusLabel: "Pronto" }, { id: "p2", name: "Secador B", status: "ready", statusLabel: "Pronto" }, { id: "p3", name: "Secador C", status: "ready", statusLabel: "Pronto" }], avatars: [] };
    const before = paletteItems("secador", big);
    const selected = before[2]!.id; // "Secador C"
    expect(resolveActive(selected, before)).toBe(2);
    const after = paletteItems("secador", { ...big, projects: big.projects.slice(0, 1) });
    const index = resolveActive(selected, after);
    expect(index).toBe(0);
    expect(after[index]!.label).toBe("Secador A");
    expect(resolveActive(selected, [])).toBe(-1);
  });
});

describe("/api/shell leve e isolado", () => {
  const summary: ShellSummary = { projects: [], avatars: [], credits: null };
  const jwt = (payload: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;

  it("usa a leitura leve dedicada (shell + worker em paralelo), nunca os cards completos", async () => {
    const backend = { shell: vi.fn(async () => summary), worker: vi.fn(async () => ({ state: "online" as const, lastSeenAt: null })), projects: vi.fn() };
    const status = await buildShellStatus({ mode: "cloud", token: jwt({ sub: "user-a", email: "ana@example.com" }), backend });
    expect(backend.shell).toHaveBeenCalledTimes(1);
    expect(backend.worker).toHaveBeenCalledTimes(1);
    expect(backend.projects).not.toHaveBeenCalled();
    expect(status.worker.state).toBe("online");
  });

  it("namespace opaco por conta (sem e-mail), estável; local separado; sem sessão nada do usuário", async () => {
    const backend = { shell: async () => summary, worker: async () => ({ state: "online" as const, lastSeenAt: null }) };
    const a = await buildShellStatus({ mode: "cloud", token: jwt({ sub: "user-a", email: "ana@example.com" }), backend });
    const b = await buildShellStatus({ mode: "cloud", token: jwt({ sub: "user-b", email: "bia@example.com" }), backend });
    expect(a.namespace).toMatch(/^u[0-9a-f]{20}$/);
    expect(a.namespace).not.toBe(b.namespace);
    expect(a.namespace).toBe(notificationNamespace(jwt({ sub: "user-a" })));
    expect(a.namespace).not.toMatch(/ana|example/);
    expect((await buildShellStatus({ mode: "local", backend })).namespace).toBe("local");
    const anon = await buildShellStatus({ mode: "cloud", token: undefined, backend: null });
    expect(anon).toMatchObject({ namespace: null, user: null, projects: null, credits: null, worker: { state: "unknown" } });
  });

  it("falha do resumo não derruba o shell; estado de worker desconhecido não vaza", async () => {
    const status = await buildShellStatus({ mode: "cloud", token: jwt({ sub: "u" }), backend: { shell: async () => { throw new Error("x"); }, worker: async () => ({ state: "weird" as never, lastSeenAt: null }) } });
    expect(status).toMatchObject({ projects: null, worker: { state: "unknown" } });
  });
});
