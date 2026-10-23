"use client";

import { UserRound } from "lucide-react";
import { useState } from "react";
import { initials } from "@/application/avatar-library";
import { cx } from "../ds";

/**
 * L8.7 — foto do avatar com fallback elegante (iniciais + gradiente discreto + ícone neutro).
 * Se a imagem falhar ao carregar, cai no fallback: nunca imagem quebrada.
 */
export function AvatarPhoto({ name, src, className, alt, rounded = "2xl", size = "card" }: { name: string; src: string | null; className?: string; alt?: string; rounded?: "none" | "xl" | "2xl"; size?: "card" | "hero" | "thumb" }) {
  const [failed, setFailed] = useState<string | null>(null);
  const ok = src && failed !== src;
  return (
    <div className={cx("relative overflow-hidden bg-surface-sunken", rounded === "none" ? "" : rounded === "xl" ? "rounded-xl" : "rounded-2xl", className)} data-avatar-photo={ok ? "image" : "fallback"}>
      {ok ? (
        // eslint-disable-next-line @next/next/no-img-element -- foto servida por rota com IDs (preview do upload)
        <img src={src} alt={alt ?? `Foto de ${name}`} loading="lazy" onError={() => setFailed(src)} className="size-full animate-reveal object-cover" />
      ) : (
        <div role="img" aria-label={`${name} (sem foto)`} className="grid size-full place-items-center bg-[radial-gradient(circle_at_30%_20%,rgb(124_58_237/0.22),transparent_60%),radial-gradient(circle_at_80%_90%,rgb(34_211_238/0.10),transparent_55%)]">
          <span className="flex flex-col items-center gap-1.5 text-fg-muted">
            <span className={cx("font-semibold tracking-tight", size === "hero" ? "text-5xl" : size === "thumb" ? "text-sm" : "text-3xl")}>{initials(name)}</span>
            {size === "thumb" ? null : <UserRound className="size-4 text-fg-subtle" aria-hidden />}
          </span>
        </div>
      )}
    </div>
  );
}
