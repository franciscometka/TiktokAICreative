"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useSyncExternalStore, useTransition, type ReactNode } from "react";
import { logoutAction } from "@/app/auth-actions";
import { cx, focusRing, Sheet } from "../ds";
import { BottomNav } from "../shell/bottom-nav";
import { isActive, NAV_FOOTER, NAV_SOON } from "../shell/nav";
import { NavIcon, SoonRow } from "../shell/nav-parts";
import { Sidebar, UserRow } from "../shell/sidebar";
import { Topbar } from "../shell/topbar";
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
/** "⌘K" no Mac/iOS, "Ctrl K" no resto (servidor: "Ctrl K"). */
function useShortcutLabel(): string {
  return useSyncExternalStore(subscribeNoop, () => (/Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘K" : "Ctrl K"), () => "Ctrl K");
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/";
  const { status, now } = useShellStatus();
  const kbd = useShortcutLabel();
  const [menuOpen, setMenuOpen] = useState(false);
  const [, startTransition] = useTransition();
  const logout = status?.mode === "cloud" && status.user ? () => startTransition(() => logoutAction()) : undefined;

  // Login: sem navegação (ainda não há sessão); só a marca e a superfície do formulário.
  if (pathname === "/login") {
    return (
      <div className="min-h-dvh bg-canvas p-2 sm:p-3">
        <div className="theme-light min-h-[calc(100dvh-1rem)] rounded-2xl ring-1 ring-line sm:min-h-[calc(100dvh-1.5rem)]">{children}</div>
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-canvas text-fg lg:flex">
      <Sidebar pathname={pathname} status={status} now={now} kbd={kbd} onLogout={logout} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar pathname={pathname} status={status} now={now} kbd={kbd} onOpenMenu={() => setMenuOpen(true)} />
        {/* Superfície clara temporária: conteúdo atual isolado, com respiro e cantos (nunca encosta nas bordas). */}
        <div className="flex flex-1 flex-col px-2 pt-2 pb-[calc(5.5rem+env(safe-area-inset-bottom))] sm:px-3 sm:pt-3 lg:pb-3">
          <div data-surface="legacy" className="theme-light flex-1 overflow-x-clip rounded-2xl ring-1 ring-white/[0.06]">
            {children}
          </div>
        </div>
      </div>
      <BottomNav pathname={pathname} />
      <MobileMenu open={menuOpen} onClose={() => setMenuOpen(false)} pathname={pathname} status={status} now={now} onLogout={logout} />
    </div>
  );
}

/** Menu mobile: áreas secundárias + worker (texto completo, sem depender de hover) + conta. */
function MobileMenu({ open, onClose, pathname, status, now, onLogout }: { open: boolean; onClose: () => void; pathname: string; status: ReturnType<typeof useShellStatus>["status"]; now: Date; onLogout?: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} title="Menu">
      <div className="space-y-5">
        <div className="rounded-xl border border-line bg-surface px-4 py-3.5">
          <WorkerStatus variant="panel" status={status?.worker ?? null} now={now} />
        </div>
        <nav aria-label="Secundária" className="flex flex-col gap-0.5">
          {NAV_SOON.filter((item) => item.id === "credits").map((item) => <SoonRow key={item.id} item={item} />)}
          {NAV_FOOTER.map((item) => {
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
