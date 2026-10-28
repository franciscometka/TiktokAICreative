"use client";

import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from "react";
import { cx } from "./styles";

/**
 * Tooltip só CSS: aparece em hover E foco de teclado (focus-within), com atraso curto na entrada.
 * Conteúdo é complementar — nada essencial pode depender dele (mobile não tem hover).
 */
export function Tooltip({ content, side = "top", align = "center", children, className }: {
  content: ReactNode;
  side?: "top" | "bottom" | "right";
  /** `end`: alinha à direita do gatilho (gatilhos na borda direita da tela — invisível ou não, o balão não pode estourar a largura). */
  align?: "center" | "end";
  children: ReactElement<{ "aria-describedby"?: string }>;
  className?: string;
}) {
  const id = useId();
  const trigger = isValidElement(children) ? cloneElement(children, { "aria-describedby": id }) : children;
  const x = align === "end" ? "right-0" : "left-1/2 -translate-x-1/2";
  return (
    <span className={cx("group/tt relative inline-flex", className)}>
      {trigger}
      <span id={id} role="tooltip"
        className={cx(
          "pointer-events-none absolute z-50 w-max max-w-64 rounded-lg border border-line-strong bg-elevated px-2.5 py-1.5 text-caption text-fg shadow-pop",
          "opacity-0 transition-[opacity,transform] duration-(--dur-fast) ease-cf",
          "group-hover/tt:opacity-100 group-hover/tt:delay-300 group-focus-within/tt:opacity-100",
          side === "top" && cx("bottom-full mb-2 translate-y-1 group-hover/tt:translate-y-0 group-focus-within/tt:translate-y-0", x),
          side === "bottom" && cx("top-full mt-2 -translate-y-1 group-hover/tt:translate-y-0 group-focus-within/tt:translate-y-0", x),
          side === "right" && "top-1/2 left-full ml-2 -translate-x-1 -translate-y-1/2 group-hover/tt:translate-x-0 group-focus-within/tt:translate-x-0",
        )}>
        {content}
      </span>
    </span>
  );
}
