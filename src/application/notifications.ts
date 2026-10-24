import type { UxEvent } from "./ux-events";

/**
 * L8.8 / L8.8.1 — central de notificações LEVE, só no navegador. Sem tabela, WebSocket, push,
 * e-mail ou cron. Por conta (namespace opaco), com no máximo `NOTIFICATION_LIMIT` itens, chaves
 * já vistas (dedupe entre polls, recargas e abas) e leitura MONOTÔNICA (lido nunca volta a não lido).
 * Nada sensível: títulos, nomes de projeto e links internos validados.
 */

export const NOTIFICATION_LIMIT = 50;
const SEEN_LIMIT = NOTIFICATION_LIMIT * 4;

/** Chave por conta: `cf:notifications:v1:<namespace>` ("local" no modo local; hash opaco no cloud). */
export function notificationsStorageKey(namespace: string): string {
  return `cf:notifications:v1:${namespace}`;
}

export interface NotificationItem extends UxEvent { read: boolean }

export interface NotificationState {
  items: NotificationItem[];
  /** Chaves já registradas (inclui as que saíram da lista pelo limite) — evita reaparecer. */
  seen: string[];
}

export const EMPTY_NOTIFICATIONS: NotificationState = { items: [], seen: [] };

/**
 * Rota interna SEGURA: começa com uma única "/", sem barra invertida, sem espaço/controle e sem
 * nada que o navegador normalize para outro host (`//x`, `/\x`, `/%2F%2Fx`, URL absoluta).
 */
export function isSafeInternalHref(href: unknown): href is string {
  if (typeof href !== "string" || href.length === 0 || href.length > 512) return false;
  if (!/^\/(?![/\\])[^\\\s\u0000-\u001f\u007f]*$/.test(href)) return false;
  let decoded: string;
  try { decoded = decodeURIComponent(href); } catch { return false; }
  if (/^\/[/\\]/.test(decoded) || /[\\\u0000-\u001f\u007f]/.test(decoded)) return false;
  try {
    return new URL(href, "https://cf.invalid").origin === "https://cf.invalid";
  } catch {
    return false;
  }
}

/** Junta dois estados (outra aba, armazenamento): união por chave, lido = lido em qualquer lado. */
export function mergeNotifications(a: NotificationState, b: NotificationState): NotificationState {
  const byKey = new Map<string, NotificationItem>();
  for (const n of [...a.items, ...b.items]) {
    const prev = byKey.get(n.key);
    byKey.set(n.key, prev ? { ...prev, read: prev.read || n.read } : n);
  }
  const items = [...byKey.values()].sort((x, y) => y.at.localeCompare(x.at) || x.key.localeCompare(y.key)).slice(0, NOTIFICATION_LIMIT);
  const seen = [...new Set([...a.seen, ...b.seen, ...items.map((n) => n.key)])].slice(-SEEN_LIMIT);
  return { items, seen };
}

export function addEvents(state: NotificationState, events: readonly UxEvent[]): { state: NotificationState; added: UxEvent[] } {
  const seen = new Set(state.seen);
  const added = events.filter((e) => { if (seen.has(e.key)) return false; seen.add(e.key); return true; });
  if (!added.length) return { state, added };
  const merged = mergeNotifications({ items: added.map((e) => ({ ...e, read: false })), seen: added.map((e) => e.key) }, state);
  return { state: merged, added };
}

export function markRead(state: NotificationState, key: string): NotificationState {
  return { ...state, items: state.items.map((n) => (n.key === key ? { ...n, read: true } : n)) };
}

export function markAllRead(state: NotificationState): NotificationState {
  return { ...state, items: state.items.map((n) => ({ ...n, read: true })) };
}

export function unreadCount(state: NotificationState): number {
  return state.items.filter((n) => !n.read).length;
}

const TONES = new Set(["success", "info", "warning", "danger"]);

/** Leitura defensiva do que está no navegador (dados velhos/corrompidos → vazio; link inseguro → fora). */
export function parseNotifications(raw: string | null): NotificationState {
  if (!raw) return EMPTY_NOTIFICATIONS;
  try {
    const data = JSON.parse(raw) as { items?: unknown; seen?: unknown };
    const items = Array.isArray(data.items) ? data.items.filter((n): n is NotificationItem =>
      !!n && typeof n === "object" && typeof (n as NotificationItem).key === "string" && typeof (n as NotificationItem).title === "string"
      && typeof (n as NotificationItem).at === "string" && TONES.has((n as NotificationItem).tone)
      && ((n as NotificationItem).href === null || isSafeInternalHref((n as NotificationItem).href))) : [];
    const seen = Array.isArray(data.seen) ? data.seen.filter((k): k is string => typeof k === "string") : [];
    return mergeNotifications({ items: items.map((n) => ({ ...n, read: n.read === true })), seen }, EMPTY_NOTIFICATIONS);
  } catch {
    return EMPTY_NOTIFICATIONS;
  }
}

export function serializeNotifications(state: NotificationState): string {
  return JSON.stringify(state);
}

/** "agora" · "há 5 min" · "há 2 h" · "ontem" · "12 out". */
export function notificationTime(at: string, now: Date): string {
  const s = Math.max(0, Math.round((now.getTime() - new Date(at).getTime()) / 1000));
  if (s < 60) return "agora";
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  if (s < 86_400) return `há ${Math.floor(s / 3600)} h`;
  if (s < 172_800) return "ontem";
  return new Date(at).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" });
}

// ---------------------------------------------------------------- store por conta (multi-aba)

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Canal entre abas (BroadcastChannel; fallback: evento `storage`). Mensagem = "o namespace mudou". */
export interface ChangeBus {
  post(namespace: string): void;
  subscribe(listener: (namespace: string) => void): () => void;
}

/**
 * Store de UMA conta. Toda escrita é ler-mesclar-gravar sobre o que está no armazenamento (outra
 * aba pode ter escrito), então gravações concorrentes não apagam itens diferentes; ao mudar, avisa
 * as outras abas, que re-leem e mesclam.
 */
export class NotificationStore {
  private state: NotificationState;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: () => void;

  constructor(readonly namespace: string, private readonly storage: KeyValueStorage | null, private readonly bus: ChangeBus | null) {
    this.state = this.readStorage();
    this.unsubscribe = bus?.subscribe((ns) => { if (ns === this.namespace) this.refresh(); }) ?? (() => undefined);
  }

  private readStorage(): NotificationState {
    try { return parseNotifications(this.storage?.getItem(notificationsStorageKey(this.namespace)) ?? null); } catch { return EMPTY_NOTIFICATIONS; }
  }

  private commit(next: NotificationState) {
    this.state = next;
    try { this.storage?.setItem(notificationsStorageKey(this.namespace), serializeNotifications(next)); } catch { /* bloqueado: fica em memória */ }
    this.bus?.post(this.namespace);
    for (const l of this.listeners) l();
  }

  get = (): NotificationState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** Outra aba mudou: mescla o armazenamento com o que esta aba tem (nada se perde, lido é monotônico). */
  refresh(): void {
    const merged = mergeNotifications(this.readStorage(), this.state);
    if (serializeNotifications(merged) === serializeNotifications(this.state)) return;
    this.state = merged;
    for (const l of this.listeners) l();
  }

  /** Registra eventos; devolve só os NOVOS para esta conta (já vistos aqui ou em outra aba = fora). */
  add(events: readonly UxEvent[]): UxEvent[] {
    const base = mergeNotifications(this.readStorage(), this.state);
    const { state, added } = addEvents(base, events);
    if (added.length) this.commit(state);
    else if (base !== this.state) this.state = base;
    return added;
  }

  markRead(key: string): void {
    this.commit(markRead(mergeNotifications(this.readStorage(), this.state), key));
  }

  markAllRead(): void {
    this.commit(markAllRead(mergeNotifications(this.readStorage(), this.state)));
  }

  dispose(): void {
    this.unsubscribe();
    this.listeners.clear();
  }
}
