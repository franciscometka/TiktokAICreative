import { cx } from "./styles";

/** Indicador de carregamento inline (botões, linhas). Nunca gigante no centro da tela. */
export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cx("size-4 shrink-0 animate-spin", className)} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.22" strokeWidth="2.5" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}
