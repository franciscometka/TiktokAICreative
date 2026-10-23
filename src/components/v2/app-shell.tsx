"use client";

import { Search } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, useTransition, type ReactNode } from "react";
import { logoutAction } from "@/app/auth-actions";
import { isPaletteShortcut } from "@/application/command-palette";
import { cx, focusRing, Sheet, ToastProvider } from "../ds";
import { CommandPalette } from "../shell/command-palette";
import { NotificationCenter, NotificationsContext } from "../shell/notification-center";
import { useUxEvents } from "../shell/use-ux-events";
import { BottomNav } from "../shell/bottom-nav";
import { CreditsPanel } from "../shell/credits-badge";
import { isActive, isDarkRoute, NAV_CREDITS, NAV_FOOTER } from "../shell/nav";
import { NavIcon } from "../shell/nav-parts";
import { Sidebar, UserRow } from "../shell/sidebar";
import { Topbar } from "../shell/topbar";
import { ShellStatusContext } from "../shell/shell-status-context";
import { useShellStatus } from "../shell/use-shell-status";
import { WorkerStatus } from "../shell/worker-status";

/**
 * Shell do Cinematic AI Studio (L8.1): dark. Sidebar (desktop) ou topbar + bottom nav (mobile).
 * Telas técnicas (jobs, providers, ledger, diagnóstico) ficam em Configurações → Avançado.
 * As telas V2 ainda não redesenhadas (e as legadas) renderizam numa superfície clara isolada
 * (`.theme-light`) dentro do shell escuro — cada lote seguinte tira a sua tela dessa ilha.
 */

export { isActive, NAV_FOOTER, NAV_MAIN, NAV_SOON } from "../shell/nav";

const subscribeNoop = () => () => undefined;
const isMacPlatform = () => /Mac|iPhone|iPad/.test(navigator.userAgent);
/** "⌘K" no Mac/iOS, "Ctrl K" no resto (servidor: "Ctrl K"). */
function useShortcutLabel(): string {
  return useSyncExternalStore(subscribeNoop, () => (isMacPlatform() ? "⌘K" : "Ctrl K"), () => "Ctrl K");
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/";
  // Login: sem navegação (ainda não há sessão); só a marca e a superfície do formulário.
  if (pathname === "/login") {
    return (
      <div className="min-h-dvh bg-canvas p-2 sm:p-3">
        <div className="theme-light min-h-[calc(100dvh-1rem)] rounded-2xl ring-1 ring-line sm:min-h-[calc(100dvh-1.5rem)]">{children}</div>
      </div>
    );
  }
  // L8.8: toasts integrados no app inteiro.
  return <ToastProvider><ShellFrame pathname={pathname}>{children}</ShellFrame></ToastProvider>;
}

function ShellFrame({ pathname, children }: { pathname: string; children: ReactNode }) {
  const shell = useShellStatus();
  const { status, now } = shell;
  const kbd = useShortcutLabel();
  const [menuOpen, setMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [, startTransition] = useTransition();
  const logout = status?.mode === "cloud" && status.user ? () => startTransition(() => logoutAction()) : undefined;
  // L8.8: eventos de UX (notificações + toasts) a partir do MESMO status do shell.
  const notifications = useUxEvents(status, pathname);
  const openPalette = useCallback(() => { setMenuOpen(false); setPaletteOpen(true); }, []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const paletteData = useMemo(() => ({ projects: status?.projects ?? [], avatars: status?.avatars ?? [] }), [status?.projects, status?.avatars]);

  // Ctrl+K / ⌘K abre e fecha (único atalho deste lote).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isPaletteShortcut(e, isMacPlatform())) return;
      e.preventDefault();
      setPaletteOpen((open) => !open);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <ShellStatusContext.Provider value={shell}>
    <NotificationsContext.Provider value={notifications}>
    <div className="min-h-dvh bg-canvas text-fg lg:flex">
      <Sidebar pathname={pathname} status={status} now={now} kbd={kbd} onLogout={logout} onOpenPalette={openPalette} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar pathname={pathname} status={status} now={now} kbd={kbd} onOpenMenu={() => setMenuOpen(true)} onOpenPalette={openPalette} />
        {isDarkRoute(pathname) ? (
          // Tela já redesenhada: dark nativo, direto no canvas.
          <div data-surface="dark" className="flex-1 pb-[calc(5.5rem+env(safe-area-inset-bottom))] lg:pb-0">{children}</div>
        ) : (
          // Superfície clara temporária: conteúdo atual isolado, com respiro e cantos (nunca encosta nas bordas).
          <div className="flex flex-1 flex-col px-2 pt-2 pb-[calc(5.5rem+env(safe-area-inset-bottom))] sm:px-3 sm:pt-3 lg:pb-3">
            <div data-surface="legacy" className="theme-light flex-1 overflow-x-clip rounded-2xl ring-1 ring-white/[0.06]">
              {children}
            </div>
          </div>
        )}
      </div>
      <BottomNav pathname={pathname} />
      <MobileMenu open={menuOpen} onClose={() => setMenuOpen(false)} pathname={pathname} status={status} now={now} onLogout={logout} onOpenPalette={openPalette} />
      <CommandPalette open={paletteOpen} onClose={closePalette} data={paletteData} />
      <NotificationCenter now={now.getTime() ? now : new Date()} />
    </div>
    </NotificationsContext.Provider>
    </ShellStatusContext.Provider>
  );
}

/** Menu mobile: áreas secundárias + worker (texto completo, sem depender de hover) + conta. */
function MobileMenu({ open, onClose, pathname, status, now, onLogout, onOpenPalette }: { open: boolean; onClose: () => void; pathname: string; status: ReturnType<typeof useShellStatus>["status"]; now: Date; onLogout?: () => void; onOpenPalette: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} title="Menu">
      <div className="space-y-5">
        <button type="button" onClick={onOpenPalette} className={cx("flex h-11 w-full items-center gap-2.5 rounded-xl border border-line bg-surface px-3 text-sm text-fg-muted hover:text-fg", focusRing)} data-open-palette>
          <Search className="size-[18px] text-fg-subtle" aria-hidden />Buscar e ações
        </button>
        <div className="divide-y divide-line rounded-xl border border-line bg-surface">
          <div className="px-4 py-3.5"><CreditsPanel summary={status?.credits ?? null} loading={!status} onNavigate={onClose} /></div>
          <div className="px-4 py-3.5"><WorkerStatus variant="panel" status={status?.worker ?? null} now={now} /></div>
        </div>
        <nav aria-label="Secundária" className="flex flex-col gap-0.5">
          {[NAV_CREDITS, ...NAV_FOOTER].map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <Link key={item.href} href={item.href} onClick={onClose} aria-current={active ? "page" : undefined}
                className={cx("flex h-11 items-center gap-2.5 rounded-lg px-2.5 text-sm font-medium", focusRing, active ? "bg-primary-soft text-fg" : "text-fg-muted hover:bg-fg/[0.04] hover:text-fg")}>
                <NavIcon icon={item.icon} active={active} className={active ? "text-primary-light" : "text-fg-subtle"} />{item.label}
              </Link>
            );
          })}
        </nav>
        {status?.user ? <div className="border-t border-line pt-3"><UserRow user={status.user} onLogout={onLogout} /></div> : null}
      </div>
    </Sheet>
  );
}
