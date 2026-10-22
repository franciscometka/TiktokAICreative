import Link from "next/link";
import { cx, focusRing, Spark } from "../ds";
import type { NavItem, SoonItem } from "./nav";

/** Peças de navegação compartilhadas por sidebar e menu mobile. */

export function NavIcon({ icon, active, className }: { icon: NavItem["icon"]; active?: boolean; className?: string }) {
  if (icon === "spark") return <Spark gradient={active} className={cx("grid size-[18px] place-items-center text-[15px]", !active && "text-current", className)} />;
  const Icon = icon;
  return <Icon aria-hidden strokeWidth={1.75} className={cx("size-[18px] shrink-0", className)} />;
}

const itemBase = cx("group relative flex h-9 items-center rounded-lg text-sm font-medium whitespace-nowrap", focusRing,
  "transition-[background-color,color] duration-(--dur-fast) ease-cf");

export function SidebarLink({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <Link href={item.href} aria-current={active ? "page" : undefined} data-active={active || undefined}
      className={cx(itemBase, "gap-2.5 px-2.5", active ? "bg-primary-soft text-fg" : "text-fg-muted hover:bg-fg/[0.04] hover:text-fg")}>
      {/* Indicação lateral do item ativo (entra com scale, transição curta). */}
      <span aria-hidden className={cx("absolute top-1/2 -left-3 h-4 w-[3px] -translate-y-1/2 rounded-r-full bg-primary-light transition-transform duration-(--dur-normal) ease-cf",
        active ? "scale-y-100" : "scale-y-0")} />
      <NavIcon icon={item.icon} active={active} className={active ? "text-primary-light" : "text-fg-subtle group-hover:text-fg-muted"} />
      <span className="truncate">{item.label}</span>
    </Link>
  );
}

/** Item ainda não disponível: não é link, anuncia "em breve" (sem botão morto). */
export function SoonRow({ item, trailing }: { item: SoonItem; trailing?: React.ReactNode }) {
  const Icon = item.icon;
  return (
    <div role="link" aria-disabled="true" title={item.hint} className={cx(itemBase, "cursor-not-allowed pr-1.5 pl-2.5 text-fg-subtle")}>
      <Icon aria-hidden strokeWidth={1.75} className="size-[18px] shrink-0 opacity-70" />
      {/* Mesmo alinhamento dos links (ícone → texto 10px); o atalho/selo encosta à direita. */}
      <span className="ml-2.5 truncate">{item.label}</span>
      <span className="ml-auto shrink-0 pl-1.5">{trailing ?? <span className="rounded-md border border-line px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-fg-subtle uppercase">Em breve</span>}</span>
    </div>
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded-[5px] border border-line bg-fg/[0.04] px-1 py-px font-mono text-[10px] whitespace-nowrap text-fg-subtle">{children}</kbd>;
}

/** Marca tipográfica: ✦ + "Creative Factory" / "AI VIDEO STUDIO". */
export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <Link href="/" aria-label="Creative Factory — Início" className={cx("group flex items-center gap-2.5 rounded-lg", focusRing)}>
      <span aria-hidden className="grid size-8 place-items-center rounded-[9px] bg-fg/[0.04] ring-1 ring-inset ring-line-strong transition-colors duration-(--dur-normal) group-hover:bg-primary-soft">
        <Spark gradient className="text-[15px]" />
      </span>
      <span className="leading-none">
        <span className="block text-[15px] font-semibold tracking-[-0.015em] text-fg">Creative Factory</span>
        {compact ? null : <span className="mt-1 block text-[10px] font-medium tracking-[0.2em] text-fg-subtle uppercase">AI Video Studio</span>}
      </span>
    </Link>
  );
}
