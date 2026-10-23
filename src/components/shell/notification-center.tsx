"use client";

import { AlertTriangle, Bell, CheckCircle2, CheckCheck, Info, XCircle } from "lucide-react";
import Link from "next/link";
import { createContext, useContext, type ReactNode } from "react";
import { notificationTime, unreadCount, type NotificationItem, type NotificationState } from "@/application/notifications";
import { Button, cx, focusRing, IconButton, interactive, Sheet } from "../ds";

/**
 * L8.8 — central de notificações leve (só navegador). Sino com contador de não lidas (o número e
 * o texto acessível indicam; não só cor). Cada item é marcado como lido ao abrir/clicar; há
 * "Marcar todas como lidas". Desktop: painel lateral; mobile: bottom sheet (DS Sheet).
 */

export interface NotificationsApi {
  state: NotificationState;
  open: boolean;
  setOpen: (open: boolean) => void;
  markRead: (key: string) => void;
  markAllRead: () => void;
}

export const NotificationsContext = createContext<NotificationsApi | null>(null);
export function useNotifications(): NotificationsApi | null {
  return useContext(NotificationsContext);
}

const ICON: Record<NotificationItem["tone"], ReactNode> = {
  success: <CheckCircle2 className="text-success" aria-hidden />,
  info: <Info className="text-primary-light" aria-hidden />,
  warning: <AlertTriangle className="text-warning" aria-hidden />,
  danger: <XCircle className="text-danger" aria-hidden />,
};

export function BellButton({ size = "sm" }: { size?: "sm" | "md" }) {
  const api = useNotifications();
  const count = api ? unreadCount(api.state) : 0;
  return (
    <IconButton label={count ? `Notificações: ${count} não ${count === 1 ? "lida" : "lidas"}` : "Notificações"} size={size} onClick={() => api?.setOpen(true)} className="relative" data-bell={count}>
      <Bell />
      {count ? <span key={count} aria-hidden className="absolute -top-0.5 -right-0.5 grid h-4 min-w-4 animate-scale-in place-items-center rounded-full bg-primary px-1 text-[10px] font-semibold text-on-primary tabular ring-2 ring-canvas">{count > 9 ? "9+" : count}</span> : null}
    </IconButton>
  );
}

export function NotificationList({ state, now, onItem, onMarkAll }: { state: NotificationState; now: Date; onItem: (key: string) => void; onMarkAll: () => void }) {
  const unread = unreadCount(state);
  if (state.items.length === 0) {
    return (
      <div className="px-2 py-14 text-center" data-notifications-empty>
        <span className="mx-auto grid size-11 place-items-center rounded-2xl bg-fg/[0.04] text-fg-subtle ring-1 ring-inset ring-line"><Bell className="size-5" aria-hidden /></span>
        <p className="mt-4 text-sm font-medium text-fg">Nenhuma notificação ainda.</p>
        <p className="mt-1 text-caption text-fg-muted">Vídeos prontos, aprovações e avisos aparecem aqui.</p>
      </div>
    );
  }
  return (
    <div data-notifications={state.items.length}>
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="text-caption text-fg-subtle">{unread ? `${unread} não ${unread === 1 ? "lida" : "lidas"}` : "Tudo lido"}</p>
        {unread ? <Button size="sm" variant="ghost" icon={<CheckCheck />} onClick={onMarkAll}>Marcar todas como lidas</Button> : null}
      </div>
      <ul className="space-y-1.5" aria-label="Notificações">
        {state.items.map((n) => {
          const body = (
            <>
              <span className="mt-0.5 shrink-0 [&_svg]:size-[18px]">{ICON[n.tone]}</span>
              <span className="min-w-0 flex-1">
                <span className="flex items-start justify-between gap-2">
                  <span className={cx("text-sm", n.read ? "text-fg-muted" : "font-medium text-fg")}>{n.title}</span>
                  <span className="shrink-0 text-[11px] text-fg-subtle tabular">{notificationTime(n.at, now)}</span>
                </span>
                {n.description ? <span className="mt-0.5 block text-caption text-fg-muted">{n.description}</span> : null}
                {n.actionLabel && n.href ? <span className="mt-1 block text-caption font-medium text-primary-light">{n.actionLabel} →</span> : null}
              </span>
              {n.read ? <span className="sr-only">Lida</span> : <><span aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full bg-primary-light" /><span className="sr-only">Não lida</span></>}
            </>
          );
          const cls = cx("flex w-full items-start gap-3 rounded-xl border p-3 text-left", interactive, focusRing, n.read ? "border-transparent hover:bg-surface-hover" : "border-line bg-surface hover:border-line-strong");
          return (
            <li key={n.key} data-notification={n.kind} data-read={n.read || undefined}>
              {n.href ? <Link href={n.href} onClick={() => onItem(n.key)} className={cls}>{body}</Link> : <button type="button" onClick={() => onItem(n.key)} className={cls}>{body}</button>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function NotificationCenter({ now }: { now: Date }) {
  const api = useNotifications();
  if (!api) return null;
  return (
    <Sheet open={api.open} onClose={() => api.setOpen(false)} title="Notificações" description="Eventos recentes do seu estúdio, guardados neste navegador.">
      <NotificationList state={api.state} now={now} onMarkAll={api.markAllRead} onItem={(key) => { api.markRead(key); api.setOpen(false); }} />
    </Sheet>
  );
}
