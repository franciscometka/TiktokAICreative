import { Bell, Menu } from "lucide-react";
import type { ShellStatus } from "@/app/api/shell/route";
import { IconButton, Tooltip } from "../ds";
import { CreditsBadge } from "./credits-badge";
import { pageTitle } from "./nav";
import { Brand, Kbd } from "./nav-parts";
import { WorkerStatus } from "./worker-status";

/**
 * Topbar minimalista. Desktop: contexto da página + worker, saldo de créditos (discreto), notificações e
 * atalho da Command Palette (os dois últimos chegam no L8.8 — aparecem desabilitados).
 * Mobile: marca + ponto do worker + menu das áreas secundárias.
 */
export function Topbar({ pathname, status, now, kbd, onOpenMenu }: { pathname: string; status: ShellStatus | null; now: Date; kbd: string; onOpenMenu: () => void }) {
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-canvas/95 pt-[env(safe-area-inset-top)]">
      {/* Desktop */}
      <div className="hidden h-14 items-center gap-4 px-6 lg:flex">
        <p className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-[-0.01em] text-fg">{pageTitle(pathname)}</p>
        <WorkerStatus variant="pill" status={status?.worker ?? null} now={now} />
        <CreditsBadge summary={status?.credits ?? null} loading={!status} />
        <span className="mx-1 h-5 w-px bg-line" aria-hidden />
        <Tooltip side="bottom" align="end" content="Notificações chegam em breve.">
          <IconButton label="Notificações (em breve)" size="sm" aria-disabled="true" className="cursor-not-allowed opacity-60 hover:bg-transparent"><Bell /></IconButton>
        </Tooltip>
        <Tooltip side="bottom" align="end" content="Command Palette chega em breve.">
          <span tabIndex={0} aria-disabled="true" aria-label={`Command Palette (em breve), atalho ${kbd}`} className="cursor-not-allowed rounded-md outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-light"><Kbd>{kbd}</Kbd></span>
        </Tooltip>
      </div>
      {/* Mobile */}
      <div className="flex h-14 items-center gap-2 px-4 lg:hidden">
        <div className="min-w-0 flex-1"><Brand compact /></div>
        <WorkerStatus variant="dot" status={status?.worker ?? null} now={now} />
        <IconButton label="Abrir menu" onClick={onOpenMenu}><Menu /></IconButton>
      </div>
    </header>
  );
}
