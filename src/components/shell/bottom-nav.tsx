import Link from "next/link";
import { cx, focusRing, Spark } from "../ds";
import { isActive, NAV_MAIN } from "./nav";
import { NavIcon } from "./nav-parts";

/**
 * Bottom navigation (mobile, < lg): Início · Criar · Projetos · Avatares. "Criar" é o destaque
 * (pílula violeta com ✦). Alvos de toque ≥ 48px, safe area inferior respeitada.
 */
export function BottomNav({ pathname }: { pathname: string }) {
  return (
    <nav aria-label="Navegação principal" className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-elevated/95 pb-[env(safe-area-inset-bottom)] lg:hidden">
      <ul className="mx-auto grid h-16 max-w-md grid-cols-4 px-2">
        {NAV_MAIN.map((item) => {
          const active = isActive(pathname, item.href);
          const create = item.icon === "spark";
          return (
            <li key={item.href} className="flex">
              <Link href={item.href} aria-current={active ? "page" : undefined} data-active={active || undefined}
                className={cx("group flex flex-1 flex-col items-center justify-center gap-1 rounded-xl text-[11px] font-medium", focusRing,
                  "transition-[color,transform] duration-(--dur-fast) ease-cf active:scale-95",
                  active ? "text-fg" : "text-fg-subtle")}>
                {create ? (
                  <span aria-hidden data-create className={cx("grid h-8 w-12 place-items-center rounded-xl bg-primary text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.2),0_6px_16px_-6px_rgb(124_58_237/0.8)]",
                    active && "ring-2 ring-primary-light/50 ring-offset-2 ring-offset-elevated")}>
                    <Spark className="text-[15px] text-white" />
                  </span>
                ) : (
                  <span className="relative grid h-8 w-12 place-items-center">
                    <NavIcon icon={item.icon} active={active} className={active ? "text-primary-light" : ""} />
                    <span aria-hidden className={cx("absolute -top-2 h-[3px] w-5 rounded-b-full bg-primary-light transition-transform duration-(--dur-normal) ease-cf", active ? "scale-x-100" : "scale-x-0")} />
                  </span>
                )}
                {item.short}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
