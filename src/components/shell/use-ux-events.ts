"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ShellStatus } from "@/app/api/shell/route";
import { addEvents, EMPTY_NOTIFICATIONS, markAllRead, markRead, NOTIFICATIONS_STORAGE_KEY, parseNotifications, serializeNotifications, type NotificationState } from "@/application/notifications";
import { diffSnapshots, toastFor, type UxSnapshot } from "@/application/ux-events";
import { useOptionalToast } from "../ds";

/**
 * L8.8 — ponte entre o status que o shell JÁ consulta e a camada pura de eventos de UX. Um único
 * lugar decide notificações e toasts (Home/Projetos/Projeto não disparam nada por conta própria).
 * - Primeiro snapshot da sessão = baseline (nenhuma notificação para o que já estava pronto).
 * - Dedupe por `key` (central + localStorage); toasts com o mesmo id substituem.
 * - Persistência só no navegador, com try/catch (modo privado/armazenamento bloqueado → em memória).
 *   Servidor/hidratação = lista vazia (sem mismatch); o navegador lê o salvo ao assinar.
 */

export function snapshotOf(status: ShellStatus): UxSnapshot {
  return {
    worker: status.worker.state,
    credits: status.credits ? { state: status.credits.state, remaining: status.credits.remaining, estimatedVideos: status.credits.estimatedVideos } : null,
    projects: (status.projects ?? []).map((p) => ({ id: p.id, name: p.name, status: p.status, durationLabel: p.durationLabel })),
  };
}

// ---------------------------------------------------------------- store do navegador

let cache: NotificationState | null = null;
const listeners = new Set<() => void>();

function read(): NotificationState {
  if (cache) return cache;
  try { cache = parseNotifications(window.localStorage.getItem(NOTIFICATIONS_STORAGE_KEY)); } catch { cache = EMPTY_NOTIFICATIONS; }
  return cache;
}
function write(next: NotificationState) {
  cache = next;
  try { window.localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, serializeNotifications(next)); } catch { /* armazenamento indisponível: fica em memória */ }
  for (const l of listeners) l();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
const serverSnapshot = () => EMPTY_NOTIFICATIONS;

export function useUxEvents(status: ShellStatus | null, pathname: string) {
  const router = useRouter();
  const toast = useOptionalToast();
  const state = useSyncExternalStore(subscribe, read, serverSnapshot);
  const [open, setOpen] = useState(false);
  const previous = useRef<UxSnapshot | null>(null);
  const pathRef = useRef(pathname);
  useEffect(() => { pathRef.current = pathname; }, [pathname]);

  useEffect(() => {
    if (!status) return;
    const fresh = snapshotOf(status);
    // Projetos não consultados nesta resposta (ex.: API fora): mantém os anteriores — sem "inventar" transições.
    const snapshot = status.projects == null && previous.current ? { ...fresh, projects: previous.current.projects } : fresh;
    const events = diffSnapshots(previous.current, snapshot);
    previous.current = snapshot;
    if (!events.length) return;
    const { state: next, added } = addEvents(read(), events);
    if (!added.length) return;
    write(next);
    for (const e of added) {
      if (!toastFor(e, pathRef.current)) continue;
      toast.show({ id: e.key, title: e.kind === "project.completed" ? `✓ ${e.title}` : e.title, description: e.description, tone: e.tone,
        ...(e.href && e.actionLabel ? { action: { label: e.actionLabel, onClick: () => router.push(e.href!) } } : {}) });
    }
  }, [status, toast, router]);

  return {
    state, open, setOpen,
    markRead: (key: string) => write(markRead(read(), key)),
    markAllRead: () => write(markAllRead(read())),
  };
}
