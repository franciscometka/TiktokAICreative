"use client";

import { Pencil, Plus, Search, X } from "lucide-react";
import Link from "next/link";
import { useId, useMemo, useState } from "react";
import type { AvatarView } from "@/application/avatar-actions";
import { AVATAR_SEARCH_THRESHOLD, defaultForLabel, queryAvatars, topTags, avatarCreateHref, type AvatarFilter } from "@/application/avatar-library";
import { Badge, buttonClass, cardClass, cx, EmptyState, focusRing, IconButton, interactive, Spark } from "../ds";
import { AvatarPhoto } from "./avatar-photo";

/**
 * L8.7 — Avatares como biblioteca de apresentadores. Cards visuais (foto grande, nome, voz, tags,
 * "✦ Padrão para …", Ativo/Inativo). Ações reais: Usar (vai ao Create com ?avatar=, só se ativo) e
 * Editar. No desktop aparecem no hover/foco; no mobile ficam sempre visíveis.
 */

const sameFilter = (a: AvatarFilter, b: AvatarFilter) => (typeof a === "string" || typeof b === "string" ? a === b : a.tag === b.tag);

export function AvatarLibrary({ avatars }: { avatars: AvatarView[] }) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<AvatarFilter>("all");
  const searchId = useId();
  const shown = useMemo(() => queryAvatars(avatars, { search, filter }), [avatars, search, filter]);
  const tools = avatars.length >= AVATAR_SEARCH_THRESHOLD;
  const filters: { id: string; label: string; value: AvatarFilter }[] = [
    { id: "all", label: "Todos", value: "all" },
    { id: "active", label: "Ativos", value: "active" },
    ...(avatars.some((a) => !a.active) ? [{ id: "inactive", label: "Inativos", value: "inactive" as const }] : []),
    ...topTags(avatars).map((t) => ({ id: `tag:${t}`, label: t, value: { tag: t } })),
  ];

  return (
    <main className="mx-auto w-full max-w-6xl px-4 pt-8 pb-12 sm:px-8 sm:pt-12">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[28px] leading-tight font-semibold tracking-tight text-fg sm:text-title">Avatares</h1>
          <p className="mt-2 text-body text-fg-muted">Apresentadores consistentes para seus vídeos.</p>
        </div>
        <Link href="/avatars/new" className={buttonClass({ variant: "primary" })}><Plus aria-hidden />Criar avatar</Link>
      </header>

      {avatars.length === 0 ? (
        <EmptyState className="mt-10" title="Nenhum apresentador ainda." description="Crie apresentadores como “Marina · beleza, cabelo”. Sem avatar, cada vídeo usa uma apresentadora gerada automaticamente."
          action={<Link href="/avatars/new" className={buttonClass({ variant: "ai" })}><Spark inherit />Criar avatar</Link>} />
      ) : (
        <>
          {tools ? (
            <div className="mt-8 space-y-3" data-avatar-tools>
              <div className="relative sm:w-80">
                <label htmlFor={searchId} className="sr-only">Buscar avatares</label>
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
                <input id={searchId} type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar por nome, tag ou voz..."
                  className={cx("block h-10 w-full rounded-[10px] border border-line bg-surface-sunken pr-9 pl-9 text-sm text-fg placeholder:text-fg-subtle", interactive, "hover:border-line-strong focus:border-primary-light/70 focus:ring-4 focus:ring-primary/15 focus:outline-none")} />
                {search ? <IconButton label="Limpar busca" size="sm" className="absolute top-1/2 right-1 -translate-y-1/2" onClick={() => setSearch("")}><X /></IconButton> : null}
              </div>
              <div role="group" aria-label="Filtrar avatares" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-0.5 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:px-0">
                {filters.map((f) => {
                  const selected = sameFilter(f.value, filter);
                  return (
                    <button key={f.id} type="button" aria-pressed={selected} onClick={() => setFilter(f.value)} data-avatar-filter={f.id}
                      className={cx("h-9 shrink-0 rounded-full px-3.5 text-[13px] font-medium whitespace-nowrap ring-1 ring-inset", interactive, focusRing,
                        selected ? "bg-primary-soft text-fg ring-primary/40" : "text-fg-muted ring-line hover:bg-surface-hover hover:text-fg")}>
                      {f.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          <p className="sr-only" aria-live="polite">{shown.length === 1 ? "1 avatar" : `${shown.length} avatares`}</p>
          {shown.length === 0 ? (
            <div className="mt-10 rounded-2xl border border-dashed border-line-strong px-6 py-12 text-center">
              <p className="text-heading font-semibold text-fg">Nenhum avatar encontrado.</p>
              <button type="button" onClick={() => { setSearch(""); setFilter("all"); }} className={cx(buttonClass({ variant: "secondary", size: "sm" }), "mt-5")}>Limpar filtros</button>
            </div>
          ) : (
            <ul className={cx("grid animate-fade-in grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3 xl:grid-cols-4", tools ? "mt-6" : "mt-8")} data-avatar-grid={shown.length}>
              {shown.map((a) => <li key={a.id} className="min-w-0"><AvatarCard avatar={a} /></li>)}
            </ul>
          )}
        </>
      )}
    </main>
  );
}

export function AvatarCard({ avatar }: { avatar: AvatarView }) {
  const standard = defaultForLabel(avatar.defaultForTags);
  return (
    <article className={cx(cardClass(), "group relative overflow-hidden transition-[transform,border-color,background-color] duration-(--dur-normal) ease-cf hover:-translate-y-[3px] hover:border-line-strong hover:bg-surface-hover")} data-avatar-card={avatar.active ? "active" : "inactive"}>
      <Link href={`/avatars/${avatar.id}`} className={cx("block", focusRing)} aria-label={`Ver perfil de ${avatar.name}${avatar.active ? "" : " (inativo)"}`}>
        <div className="relative aspect-[4/5] overflow-hidden">
          <AvatarPhoto name={avatar.name} src={avatar.imageUrl} alt="" rounded="none" className="size-full transition-transform duration-(--dur-emph) ease-cf group-hover:scale-[1.03]" />
          <span className="absolute top-2.5 left-2.5 rounded-full bg-canvas/85"><Badge tone={avatar.active ? "success" : "neutral"} dot>{avatar.active ? "Ativo" : "Inativo"}</Badge></span>
        </div>
        <div className="space-y-1 p-3 sm:p-4">
          <p className="truncate font-medium text-fg">{avatar.name}</p>
          <p className="truncate text-caption text-fg-muted">{avatar.voiceName ?? "Voz não definida"}</p>
          {avatar.tags.length ? <p className="truncate text-caption text-fg-subtle">{avatar.tags.slice(0, 3).join(" · ")}</p> : null}
          {standard ? <p className="flex items-center gap-1 truncate text-caption font-medium text-primary-light" data-default-for><Spark inherit className="text-[10px]" />{standard}</p> : null}
        </div>
      </Link>
      {/* Ações: sempre visíveis no mobile; no desktop aparecem no hover ou quando algo do card tem foco. */}
      <div className="flex flex-col gap-1.5 border-t border-line p-2.5 sm:absolute sm:flex-row sm:gap-2 sm:inset-x-0 sm:bottom-0 sm:border-t-0 sm:bg-surface-hover/95 sm:opacity-0 sm:transition-opacity sm:duration-(--dur-fast) sm:group-focus-within:opacity-100 sm:group-hover:opacity-100" data-avatar-actions>
        {avatar.active ? <Link href={avatarCreateHref(avatar.id)} className={cx(buttonClass({ size: "sm" }), "flex-1")} aria-label={`Usar ${avatar.name} em novo vídeo`}><Spark inherit />Usar</Link> : null}
        <Link href={`/avatars/${avatar.id}/edit`} className={cx(buttonClass({ variant: "secondary", size: "sm" }), "flex-1")} aria-label={`Editar ${avatar.name}`}><Pencil aria-hidden />Editar</Link>
      </div>
    </article>
  );
}
