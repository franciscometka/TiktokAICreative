import type { ReactNode } from "react";
import { cx } from "./styles";

/**
 * Ilha de tema. `ThemeLight` protege telas legadas/técnicas com classes claras hardcoded
 * (wizard avançado, `?view=advanced`, jobs, diagnósticos): os tokens do DS viram claros, o texto
 * herdado volta a escuro e o fundo é o cinza claro de antes. `ThemeDark` faz o inverso.
 */
export function ThemeLight({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("theme-light", className)}>{children}</div>;
}

export function ThemeDark({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("theme-dark bg-canvas text-fg", className)}>{children}</div>;
}
