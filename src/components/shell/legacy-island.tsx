import type { ReactNode } from "react";

/**
 * Ilha clara para telas técnicas/legadas dentro de uma rota já dark (ex.: `?mode=advanced`,
 * `?view=advanced`, projetos antigos). Mesmo visual da superfície clara do shell.
 */
export function LegacyIsland({ children }: { children: ReactNode }) {
  return (
    <div className="px-2 pt-2 sm:px-3 sm:pt-3">
      <div data-surface="legacy" className="theme-light overflow-x-clip rounded-2xl ring-1 ring-white/[0.06]">{children}</div>
    </div>
  );
}
