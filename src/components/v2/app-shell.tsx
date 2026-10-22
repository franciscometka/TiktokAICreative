"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { cx } from "../ui/primitives";

/**
 * Navegação V2 (Lote 6): Início · Criar vídeo · Projetos · Avatares | Configurações.
 * Telas técnicas (jobs, providers, ledger, diagnóstico) ficam em Configurações → Avançado.
 * L8.0: o shell inteiro fica na ilha clara (`.theme-light`) até o redesign do L8.1.
 */

export const NAV_MAIN = [
  { href: "/", label: "Início", icon: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" },
  { href: "/create", label: "Criar vídeo", icon: "M12 5v14M5 12h14" },
  { href: "/projects", label: "Projetos", icon: "M4 5h7v7H4zM13 5h7v7h-7zM4 14h7v5H4zM13 14h7v5h-7z" },
  { href: "/avatars", label: "Avatares", icon: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-7 9a7 7 0 0 1 14 0" },
] as const;
export const NAV_FOOTER = [{ href: "/settings", label: "Configurações", icon: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm8-3 2-1-2-4-2 .5-1.5-1L16 4h-4l-.5 2.5-1.5 1L8 7 6 11l2 1-.1 1L6 14l2 4 2-.5 1.5 1L12 21h4l.5-2.5 1.5-1 2 .5 2-4-2-1z" }] as const;

export function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  if (href === "/projects") return pathname.startsWith("/projects") || pathname.startsWith("/campaigns");
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavLink({ href, label, icon, active }: { href: string; label: string; icon: string; active: boolean }) {
  return (
    <Link href={href} aria-current={active ? "page" : undefined}
      className={cx("flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium whitespace-nowrap transition", active ? "bg-zinc-100 text-zinc-950" : "text-zinc-500 hover:bg-zinc-50 hover:text-zinc-900")}>
      <svg viewBox="0 0 24 24" className="size-[18px] shrink-0" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={icon} /></svg>
      <span>{label}</span>
    </Link>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/";
  return (
    <div className="theme-light min-h-screen bg-[#f7f7f8] lg:grid lg:grid-cols-[15rem_minmax(0,1fr)]">
      <aside className="sticky top-0 z-30 border-b border-zinc-200/70 bg-white lg:h-screen lg:border-r lg:border-b-0">
        <div className="flex items-center gap-2.5 px-5 py-4 lg:py-6">
          <span className="grid size-7 place-items-center rounded-lg bg-zinc-950 text-[11px] font-bold text-white" aria-hidden>CF</span>
          <span className="text-[15px] font-semibold tracking-tight text-zinc-950">Creative Factory</span>
        </div>
        <nav aria-label="Principal" className="flex gap-1 overflow-x-auto px-3 pb-3 lg:flex-col lg:overflow-visible lg:pb-0">
          {NAV_MAIN.map((item) => <NavLink key={item.href} {...item} active={isActive(pathname, item.href)} />)}
          <div className="mx-2 hidden h-px bg-zinc-100 lg:my-3 lg:block" role="separator" />
          {NAV_FOOTER.map((item) => <NavLink key={item.href} {...item} active={isActive(pathname, item.href)} />)}
        </nav>
      </aside>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
