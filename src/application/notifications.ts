import type { CreditsSnapshot, UxEvent } from "./ux-events";

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
  /** Episódio monotônico por período + franquia; persiste o rearme entre reloads e abas. */
  creditEpisodes: Record<string, { revision: number; state: CreditsSnapshot["state"] }>;
}

export const EMPTY_NOTIFICATIONS: NotificationState = { items: [], seen: [], creditEpisodes: {} };

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
  const creditEpisodes = { ...a.creditEpisodes };
  const stateRank: Record<CreditsSnapshot["state"], number> = { normal: 0, low: 1, empty: 2 };
  for (const [key, candidate] of Object.entries(b.creditEpisodes)) {
    const current = creditEpisodes[key];
    if (!current || candidate.revision > current.revision || (candidate.revision === current.revision && stateRank[candidate.state] > stateRank[current.state])) creditEpisodes[key] = candidate;
  }
  return { items, seen, creditEpisodes };
}

export function addEvents(state: NotificationState, events: readonly UxEvent[]): { state: NotificationState; added: UxEvent[] } {
  const seen = new Set(state.seen);
  const added = events.filter((e) => { if (seen.has(e.key)) return false; seen.add(e.key); return true; });
  if (!added.length) return { state, added };
  const merged = mergeNotifications({ items: added.map((e) => ({ ...e, read: false })), seen: added.map((e) => e.key), creditEpisodes: {} }, state);
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
    const data = JSON.parse(raw) as { items?: unknown; seen?: unknown; creditEpisodes?: unknown };
    const items = Array.isArray(data.items) ? data.items.filter((n): n is NotificationItem =>
      !!n && typeof n === "object" && typeof (n as NotificationItem).key === "string" && typeof (n as NotificationItem).title === "string"
      && typeof (n as NotificationItem).at === "string" && TONES.has((n as NotificationItem).tone)
      && ((n as NotificationItem).href === null || isSafeInternalHref((n as NotificationItem).href))) : [];
    const seen = Array.isArray(data.seen) ? data.seen.filter((k): k is string => typeof k === "string") : [];
    const creditEpisodes: NotificationState["creditEpisodes"] = {};
    if (data.creditEpisodes && typeof data.creditEpisodes === "object" && !Array.isArray(data.creditEpisodes)) {
      for (const [key, value] of Object.entries(data.creditEpisodes)) {
        if (!value || typeof value !== "object") continue;
        const episode = value as { revision?: unknown; state?: unknown };
        if (Number.isInteger(episode.revision) && (episode.revision as number) >= 0 && (episode.state === "normal" || episode.state === "low" || episode.state === "empty")) {
          creditEpisodes[key] = { revision: episode.revision as number, state: episode.state };
        }
      }
    }
    return mergeNotifications({ items: items.map((n) => ({ ...n, read: n.read === true })), seen, creditEpisodes }, EMPTY_NOTIFICATIONS);
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
  add(events: readonly UxEvent[], credits: CreditsSnapshot | null = null): UxEvent[] {
    const base = mergeNotifications(this.readStorage(), this.state);
    let tracked = base;
    let revision: number | null = null;
    if (credits) {
      const episodeKey = `${credits.periodStart}:${credits.allowance}`;
      const previous = base.creditEpisodes[episodeKey];
      const episode = previous
        ? { revision: previous.revision + (credits.state === "normal" && previous.state !== "normal" ? 1 : 0), state: credits.state }
        : { revision: 0, state: credits.state };
      revision = episode.revision;
      if (!previous || previous.revision !== episode.revision || previous.state !== episode.state) {
        tracked = { ...base, creditEpisodes: { ...base.creditEpisodes, [episodeKey]: episode } };
      }
    }
    const revised = revision === null ? events : events.map((event) =>
      event.kind === "credits.low" || event.kind === "credits.empty" ? { ...event, key: `${event.key}:${revision}` } : event);
    const { state, added } = addEvents(tracked, revised);
    if (added.length || tracked !== base) this.commit(state);
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
