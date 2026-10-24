"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ShellStatus } from "@/app/api/shell/route";
import { EMPTY_NOTIFICATIONS, notificationsStorageKey, NotificationStore, type ChangeBus, type NotificationState } from "@/application/notifications";
import { stepUx, toastFor, type UxMemory, type UxSnapshot } from "@/application/ux-events";
import { useOptionalToast } from "../ds";

/**
 * L8.8 / L8.8.1 — ponte entre o status que o shell JÁ consulta e a camada pura de eventos de UX.
 * Um único lugar decide notificações e toasts.
 * - Store POR CONTA (namespace opaco do servidor; "local" no modo local). Trocar de conta troca de
 *   store na hora; sem sessão (null) = nada lido/gravado. Logout abandona o store em memória.
 * - Memória dos eventos também é por conta: a troca A → B vira baseline (nada da conta A vaza).
 * - Multi-aba: BroadcastChannel (fallback: evento `storage`); escrita ler-mesclar-gravar; toast só
 *   para evento que ESTA aba registrou primeiro.
 */

export function snapshotOf(status: ShellStatus): UxSnapshot {
  return {
    worker: { state: status.worker.state, lastSeenAt: status.worker.lastSeenAt },
    credits: status.credits ? { state: status.credits.state, remaining: status.credits.remaining, allowance: status.credits.allowance, estimatedVideos: status.credits.estimatedVideos, periodStart: status.credits.periodStart } : null,
    projects: status.projects == null ? null : status.projects.map((p) => ({ id: p.id, name: p.name, status: p.status, durationLabel: p.durationLabel, episode: p.episode })),
  };
}

// ---------------------------------------------------------------- stores do navegador (um por conta)

function browserBus(): ChangeBus | null {
  if (typeof window === "undefined") return null;
  const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("cf-notifications") : null;
  return {
    post: (ns) => channel?.postMessage(ns),
    subscribe: (listener) => {
      const onMessage = (e: MessageEvent) => { if (typeof e.data === "string") listener(e.data); };
      // Fallback (e reforço): outra aba gravou no localStorage.
      const onStorage = (e: StorageEvent) => { if (e.key?.startsWith(notificationsStorageKey(""))) listener(e.key.slice(notificationsStorageKey("").length)); };
      channel?.addEventListener("message", onMessage);
      window.addEventListener("storage", onStorage);
      return () => { channel?.removeEventListener("message", onMessage); window.removeEventListener("storage", onStorage); };
    },
  };
}

function browserStorage() {
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
}

/** L8.8 gravava numa chave GLOBAL (sem conta): apaga uma vez, para não sobrar dado de outra conta. */
const LEGACY_GLOBAL_KEY = "cf:notifications:v1";
let legacyCleaned = false;
function cleanLegacy() {
  if (legacyCleaned) return;
  legacyCleaned = true;
  try { browserStorage()?.removeItem(LEGACY_GLOBAL_KEY); } catch { /* sem armazenamento */ }
}

let current: NotificationStore | null = null;
/** Store da conta atual. Conta diferente = store novo (o anterior é descartado da memória). */
export function storeFor(namespace: string | null): NotificationStore | null {
  cleanLegacy();
  if (!namespace) { current?.dispose(); current = null; return null; }
  if (current?.namespace === namespace) return current;
  current?.dispose();
  current = new NotificationStore(namespace, browserStorage(), browserBus());
  return current;
}

const noopSubscribe = () => () => undefined;
const empty = () => EMPTY_NOTIFICATIONS;

export function useUxEvents(status: ShellStatus | null, pathname: string) {
  const router = useRouter();
  const toast = useOptionalToast();
  const namespace = status?.namespace ?? null;
  const store = typeof window === "undefined" ? null : storeFor(namespace);
  const state: NotificationState = useSyncExternalStore(store?.subscribe ?? noopSubscribe, store?.get ?? empty, empty);
  const [open, setOpen] = useState(false);
  const memory = useRef<{ namespace: string | null; value: UxMemory | null }>({ namespace: null, value: null });
  const pathRef = useRef(pathname);
  useEffect(() => { pathRef.current = pathname; }, [pathname]);

  useEffect(() => {
    if (!status) return;
    const ns = status.namespace ?? null;
    const target = storeFor(ns);
    // Conta mudou (ou saiu): recomeça do zero — baseline, sem comparar com a conta anterior.
    if (memory.current.namespace !== ns) memory.current = { namespace: ns, value: null };
    if (!target) return;
    const snapshot = snapshotOf(status);
    const { events, memory: next } = stepUx(memory.current.value, snapshot);
    memory.current = { namespace: ns, value: next };
    const added = target.add(events, snapshot.credits);
    if (!added.length) return;
    for (const e of added) {
      if (!toastFor(e, pathRef.current)) continue;
      toast.show({ id: e.key, title: e.kind === "project.completed" ? `✓ ${e.title}` : e.title, description: e.description, tone: e.tone,
        ...(e.href && e.actionLabel ? { action: { label: e.actionLabel, onClick: () => router.push(e.href!) } } : {}) });
    }
  }, [status, toast, router]);

  return {
    state, open, setOpen,
    markRead: (key: string) => store?.markRead(key),
    markAllRead: () => store?.markAllRead(),
  };
}
