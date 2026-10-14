"use client";

import { useState } from "react";
import { buttonClasses } from "../ui/primitives";

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
    setTimeout(() => setState("idle"), 1_800);
  }

  return (
    <button type="button" onClick={copy} className={buttonClasses("ghost", "sm")} aria-label={label}>
      <span aria-live="polite">{state === "copied" ? "Copiado" : state === "failed" ? "Falhou" : "Copiar"}</span>
    </button>
  );
}
