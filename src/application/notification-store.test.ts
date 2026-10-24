import { describe, expect, it } from "vitest";
import { notificationsStorageKey, NotificationStore, type ChangeBus, type KeyValueStorage } from "./notifications";
import type { UxEvent } from "./ux-events";

/** L8.8.1 — store de notificações: isolamento por conta (mesmo processo JS) e coordenação entre abas. */

const event = (key: string, at = "2026-10-23T15:00:00.000Z"): UxEvent => ({ key, kind: "project.completed", tone: "success", title: "Seu vídeo está pronto", description: key, href: "/projects", actionLabel: "Ver resultado", at });

/** localStorage falso compartilhado (como o do navegador entre abas da mesma origem). */
function memoryStorage(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } };
}
/** BroadcastChannel falso: entrega a TODAS as abas inscritas (inclusive a emissora, que ignora pelo merge). */
function memoryBus(): ChangeBus {
  const listeners = new Set<(ns: string) => void>();
  return { post: (ns) => { for (const l of listeners) l(ns); }, subscribe: (l) => { listeners.add(l); return () => listeners.delete(l); } };
}

describe("isolamento por conta", () => {
  it("A grava → troca para B → B não vê A → B grava → volta para A → A vê só A; local separado", () => {
    const storage = memoryStorage();
    const bus = memoryBus();
    let store = new NotificationStore("uA", storage, bus);
    expect(store.add([event("project:a1:completed:r1")])).toHaveLength(1);
    store.dispose();

    store = new NotificationStore("uB", storage, bus);
    expect(store.get().items).toEqual([]);
    expect(store.add([event("project:b1:completed:r1")])).toHaveLength(1);
    // A mesma chave em outra conta é OUTRO evento (não é engolida pelo "visto" de A).
    expect(store.add([event("project:a1:completed:r1")])).toHaveLength(1);
    store.dispose();

    store = new NotificationStore("uA", storage, bus);
    expect(store.get().items.map((n) => n.key)).toEqual(["project:a1:completed:r1"]);
    store.dispose();

    const local = new NotificationStore("local", storage, bus);
    expect(local.get().items).toEqual([]);
    expect([...storage.data.keys()].sort()).toEqual([notificationsStorageKey("local"), notificationsStorageKey("uA"), notificationsStorageKey("uB")].filter((k) => storage.data.has(k)).sort());
    expect([...storage.data.keys()].every((k) => !k.includes("@"))).toBe(true);
  });
});

describe("multi-aba", () => {
  it("A cria → B recebe; B marca lido → A converge; nada volta a não lido", () => {
    const storage = memoryStorage();
    const bus = memoryBus();
    const a = new NotificationStore("uA", storage, bus);
    const b = new NotificationStore("uA", storage, bus);
    a.add([event("e1")]);
    expect(b.get().items.map((n) => n.key)).toEqual(["e1"]);
    b.markRead("e1");
    expect(a.get().items[0]!.read).toBe(true);
    // A, com estado antigo em memória, grava outra coisa: o "lido" de B não é desfeito.
    a.add([event("e2", "2026-10-23T15:01:00.000Z")]);
    expect(b.get().items.find((n) => n.key === "e1")!.read).toBe(true);
    expect(b.get().items.map((n) => n.key)).toEqual(["e2", "e1"]);
  });

  it("gravações concorrentes de eventos diferentes não se apagam; o mesmo evento não duplica (toast só numa aba)", () => {
    const storage = memoryStorage();
    // Sem canal (só storage): cada aba ainda lê-mescla-grava.
    const a = new NotificationStore("uA", storage, null);
    const b = new NotificationStore("uA", storage, null);
    expect(a.add([event("x1")])).toHaveLength(1);
    expect(b.add([event("x2", "2026-10-23T15:01:00.000Z")])).toHaveLength(1);
    expect(b.add([event("x1")])).toHaveLength(0); // A já registrou: B não mostra toast de novo
    a.refresh();
    expect(a.get().items.map((n) => n.key).sort()).toEqual(["x1", "x2"]);
  });

  it("armazenamento bloqueado: funciona em memória sem quebrar", () => {
    const blocked: KeyValueStorage = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    const s = new NotificationStore("uA", blocked, null);
    expect(s.add([event("e")])).toHaveLength(1);
    expect(s.get().items).toHaveLength(1);
  });
});
