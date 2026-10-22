import { LogOut } from "lucide-react";
import type { ShellStatus } from "@/app/api/shell/route";
import { cx, IconButton } from "../ds";
import { CreditsPanel } from "./credits-badge";
import { isActive, NAV_CREDITS, NAV_FOOTER, NAV_MAIN, NAV_SOON } from "./nav";
import { Brand, Kbd, SidebarLink, SoonRow } from "./nav-parts";
import { WorkerStatus } from "./worker-status";

/**
 * Sidebar desktop (≥ lg, 240px): marca, navegação principal, secundárias e, embaixo, worker +
 * usuário. Presentacional: rota e status chegam por props.
 */
export function Sidebar({ pathname, status, now, kbd, onLogout }: { pathname: string; status: ShellStatus | null; now: Date; kbd: string; onLogout?: () => void }) {
  return (
    <aside aria-label="Barra lateral" className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-line bg-elevated lg:flex">
      <div className="px-5 pt-6 pb-7"><Brand /></div>
      <nav aria-label="Principal" className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-3">
        {NAV_MAIN.map((item) => <SidebarLink key={item.href} item={item} active={isActive(pathname, item.href)} />)}
        <div role="separator" className="mx-2.5 my-3 h-px bg-line" />
        <SidebarLink item={NAV_CREDITS} active={isActive(pathname, NAV_CREDITS.href)} />
        {NAV_SOON.map((item) => <SoonRow key={item.id} item={item} trailing={item.id === "palette" ? <Kbd>{kbd}</Kbd> : undefined} />)}
        {NAV_FOOTER.map((item) => <SidebarLink key={item.href} item={item} active={isActive(pathname, item.href)} />)}
      </nav>
      <div className="space-y-2 p-3">
        <div className="divide-y divide-line rounded-xl border border-line bg-surface">
          <div className="px-3.5 py-3"><CreditsPanel summary={status?.credits ?? null} loading={!status} /></div>
          <div className="px-3.5 py-3"><WorkerStatus variant="panel" status={status?.worker ?? null} now={now} /></div>
        </div>
        <UserRow user={status?.user ?? null} onLogout={onLogout} />
      </div>
    </aside>
  );
}

export function UserRow({ user, onLogout, className }: { user: ShellStatus["user"]; onLogout?: () => void; className?: string }) {
  if (!user) return null;
  return (
    <div className={cx("flex items-center gap-3 rounded-xl px-2 py-1.5", className)}>
      <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-full bg-primary-soft text-[13px] font-semibold text-primary-light ring-1 ring-inset ring-primary/25">{user.initial}</span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{user.label}</span>
      {onLogout ? <IconButton label="Sair" size="sm" onClick={onLogout}><LogOut /></IconButton> : null}
    </div>
  );
}
