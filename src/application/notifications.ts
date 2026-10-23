import type { UxEvent } from "./ux-events";

/**
 * L8.8 — central de notificações LEVE, só no navegador (localStorage). Sem tabela, WebSocket,
 * push, e-mail ou cron. Guarda no máximo `NOTIFICATION_LIMIT` itens (os mais novos), quais chaves
 * já foram vistas (dedupe entre polls e recargas) e quais foram lidas. Nada sensível: só títulos,
 * nomes de projeto e links internos.
 */

export const NOTIFICATION_LIMIT = 50;
export const NOTIFICATIONS_STORAGE_KEY = "cf:notifications:v1";

export interface NotificationItem extends UxEvent { read: boolean }

export interface NotificationState {
  items: NotificationItem[];
  /** Chaves já registradas (inclui as que saíram da lista pelo limite) — evita reaparecer. */
  seen: string[];
}

export const EMPTY_NOTIFICATIONS: NotificationState = { items: [], seen: [] };

export function addEvents(state: NotificationState, events: readonly UxEvent[]): { state: NotificationState; added: UxEvent[] } {
  const seen = new Set(state.seen);
  const added = events.filter((e) => { if (seen.has(e.key)) return false; seen.add(e.key); return true; });
  if (!added.length) return { state, added };
  const items = [...added.map((e) => ({ ...e, read: false })).reverse(), ...state.items].slice(0, NOTIFICATION_LIMIT);
  return { state: { items, seen: [...seen].slice(-NOTIFICATION_LIMIT * 4) }, added };
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

/** Leitura defensiva do que está no navegador (dados velhos/corrompidos → vazio). */
export function parseNotifications(raw: string | null): NotificationState {
  if (!raw) return EMPTY_NOTIFICATIONS;
  try {
    const data = JSON.parse(raw) as { items?: unknown; seen?: unknown };
    const items = Array.isArray(data.items) ? data.items.filter((n): n is NotificationItem =>
      !!n && typeof n === "object" && typeof (n as NotificationItem).key === "string" && typeof (n as NotificationItem).title === "string" && TONES.has((n as NotificationItem).tone)
      && (((n as NotificationItem).href === null) || (typeof (n as NotificationItem).href === "string" && (n as NotificationItem).href!.startsWith("/")))) : [];
    const seen = Array.isArray(data.seen) ? data.seen.filter((k): k is string => typeof k === "string") : [];
    return { items: items.slice(0, NOTIFICATION_LIMIT).map((n) => ({ ...n, read: n.read === true })), seen: [...new Set([...seen, ...items.map((n) => n.key)])] };
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
