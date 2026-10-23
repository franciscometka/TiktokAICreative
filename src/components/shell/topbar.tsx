import { Menu, Search } from "lucide-react";
import type { ShellStatus } from "@/app/api/shell/route";
import { cx, focusRing, IconButton, interactive, Tooltip } from "../ds";
import { CreditsBadge } from "./credits-badge";
import { pageTitle } from "./nav";
import { Brand, Kbd } from "./nav-parts";
import { BellButton } from "./notification-center";
import { WorkerStatus } from "./worker-status";

/**
 * Topbar minimalista. Desktop: contexto da página + worker, saldo de créditos (discreto), notificações e
 * Command Palette (L8.8: funcionando). Mobile: marca + ponto do worker + busca + notificações + menu.
 */
export function Topbar({ pathname, status, now, kbd, onOpenMenu, onOpenPalette }: { pathname: string; status: ShellStatus | null; now: Date; kbd: string; onOpenMenu: () => void; onOpenPalette?: () => void }) {
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-canvas/95 pt-[env(safe-area-inset-top)]">
      {/* Desktop */}
      <div className="hidden h-14 items-center gap-4 px-6 lg:flex">
        <p className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-[-0.01em] text-fg">{pageTitle(pathname)}</p>
        <WorkerStatus variant="pill" status={status?.worker ?? null} now={now} />
        <CreditsBadge summary={status?.credits ?? null} loading={!status} />
        <span className="mx-1 h-5 w-px bg-line" aria-hidden />
        <BellButton />
        <Tooltip side="bottom" align="end" content="Buscar e ações">
          <button type="button" onClick={onOpenPalette} aria-label={`Abrir Command Palette (${kbd})`} aria-haspopup="dialog" data-open-palette
            className={cx("inline-flex h-8 items-center gap-2 rounded-lg border border-line px-2.5 text-caption text-fg-subtle hover:border-line-strong hover:text-fg", interactive, focusRing)}>
            <Search className="size-3.5" aria-hidden /><Kbd>{kbd}</Kbd>
          </button>
        </Tooltip>
      </div>
      {/* Mobile */}
      <div className="flex h-14 items-center gap-2 px-4 lg:hidden">
        <div className="min-w-0 flex-1"><Brand compact /></div>
        <WorkerStatus variant="dot" status={status?.worker ?? null} now={now} />
        <IconButton label="Buscar e ações" onClick={onOpenPalette}><Search /></IconButton>
        <BellButton size="md" />
        <IconButton label="Abrir menu" onClick={onOpenMenu}><Menu /></IconButton>
      </div>
    </header>
  );
}
