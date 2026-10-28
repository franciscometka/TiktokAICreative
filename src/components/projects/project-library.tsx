"use client";

import { ArrowUpRight, ImageOff, Plus, Search, X } from "lucide-react";
import Link from "next/link";
import { useId, useMemo, useState } from "react";
import { matchesFilter, PROJECT_FILTERS, PROJECT_SORTS, queryProjects, type ProjectCard, type ProjectFilter, type ProjectSort } from "@/application/project-v2-view";
import { actualCreditsFromBrl, estimatedCreditsFromBrl, formatCredits } from "@/costs/credits";
import { buttonClass, cardClass, cx, EmptyState, focusRing, IconButton, interactive, Select, Spark } from "../ds";
import { useShellStatusContext } from "../shell/shell-status-context";
import { ProjectStatusBadge } from "./project-status";

/**
 * L8.6 — Projetos como biblioteca visual. Busca (nome, produto, avatar), filtros por estados REAIS
 * e ordenação no cliente — instantâneos, sem recarregar a rota. Cards só com imagem (nada de MP4
 * no grid). Ação real única: abrir (cards inteiros são links). Sem "Duplicar"/"Excluir": não há
 * suporte equivalente no cloud ainda.
 */

export function ProjectLibrary({ cards }: { cards: ProjectCard[] }) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ProjectFilter>("all");
  const [sort, setSort] = useState<ProjectSort>("recent");
  const searchId = useId();
  const sortId = useId();
  const shown = useMemo(() => queryProjects(cards, { search, filter, sort }), [cards, search, filter, sort]);
  const hasCost = cards.some((c) => c.actualBrl !== null);

  return (
    <main className="mx-auto w-full max-w-6xl px-4 pt-8 pb-12 sm:px-8 sm:pt-12">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[28px] leading-tight font-semibold tracking-tight text-fg sm:text-title">Projetos</h1>
          <p className="mt-2 text-body text-fg-muted">Seus criativos em um só lugar.</p>
        </div>
        <Link href="/create" className={buttonClass({ variant: "primary" })}><Plus aria-hidden />Novo vídeo</Link>
      </header>

      {cards.length === 0 ? (
        <EmptyState className="mt-10" title="Seu estúdio ainda está vazio." description="Crie seu primeiro vídeo e ele aparecerá aqui."
          action={<Link href="/create" className={buttonClass({ variant: "ai" })}><Spark inherit />Criar vídeo</Link>} />
      ) : (
        <>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative min-w-0 sm:w-80">
              <label htmlFor={searchId} className="sr-only">Buscar projetos</label>
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
              <input id={searchId} type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar projetos..."
                className={cx("block h-10 w-full rounded-[10px] border border-line bg-surface-sunken pr-9 pl-9 text-sm text-fg placeholder:text-fg-subtle", interactive, "hover:border-line-strong focus:border-primary-light/70 focus:ring-4 focus:ring-primary/15 focus:outline-none")} />
              {search ? <IconButton label="Limpar busca" size="sm" className="absolute top-1/2 right-1 -translate-y-1/2" onClick={() => setSearch("")}><X /></IconButton> : null}
            </div>
            <div className="flex items-center gap-2">
              <label htmlFor={sortId} className="shrink-0 text-caption text-fg-subtle">Ordenar</label>
              <Select id={sortId} value={sort} onChange={(e) => setSort(e.target.value as ProjectSort)} className="w-44">
                {PROJECT_SORTS.filter((s) => s.id !== "cost" || hasCost).map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </Select>
            </div>
          </div>
            <div role="group" aria-label="Filtrar por status" className="-mx-4 mt-3 flex gap-2 overflow-x-auto px-4 pb-0.5 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:px-0">
              {PROJECT_FILTERS.map((f) => {
                const count = cards.filter((c) => matchesFilter(c, f.id)).length;
                const selected = f.id === filter;
                return (
                  <button key={f.id} type="button" aria-pressed={selected} onClick={() => setFilter(f.id)} data-filter={f.id}
                    className={cx("inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium whitespace-nowrap ring-1 ring-inset", interactive, focusRing,
                      selected ? "bg-primary-soft text-fg ring-primary/40" : "text-fg-muted ring-line hover:bg-surface-hover hover:text-fg")}>
                    {f.label}<span className={cx("tabular", selected ? "text-primary-light" : "text-fg-subtle")}>{count}</span>
                  </button>
                );
              })}
            </div>

          <p className="sr-only" aria-live="polite">{shown.length === 1 ? "1 projeto" : `${shown.length} projetos`}</p>
          {shown.length === 0 ? (
            <div className="mt-10 rounded-2xl border border-dashed border-line-strong px-6 py-12 text-center" data-no-results>
              <p className="text-heading font-semibold text-fg">Nenhum projeto encontrado.</p>
              <p className="mt-2 text-sm text-fg-muted">Ajuste a busca ou o filtro.</p>
              <button type="button" onClick={() => { setSearch(""); setFilter("all"); }} className={cx(buttonClass({ variant: "secondary", size: "sm" }), "mt-5")}>Limpar filtros</button>
            </div>
          ) : (
            <ul key={`${filter}-${sort}`} className="mt-6 grid animate-fade-in grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" data-project-grid={shown.length}>
              {shown.map((card) => <li key={card.id} className="min-w-0"><ProjectTile card={card} /></li>)}
            </ul>
          )}
        </>
      )}
    </main>
  );
}

/** Créditos do card: real (ledger) quando concluído; estimativa "~" só em produção. */
export function cardCredits(card: ProjectCard, perBrl: number | null): string | null {
  if (!perBrl) return null;
  if ((card.status === "ready" || card.status === "failed" || card.status === "blocked" || card.status === "attention") && card.actualBrl) return `${formatCredits(actualCreditsFromBrl(card.actualBrl, perBrl))} créditos`;
  if ((card.status === "generating" || card.status === "queued") && card.estimatedBrl) return `~${formatCredits(estimatedCreditsFromBrl(card.estimatedBrl, perBrl))} créditos`;
  return null;
}

export function ProjectTile({ card }: { card: ProjectCard }) {
  const { status } = useShellStatusContext();
  const credits = cardCredits(card, status?.credits?.creditsPerBrl ?? null);
  return (
    <Link href={`/campaigns/${card.id}`} aria-label={`Abrir ${card.name} — ${card.statusLabel}`} data-project-card={card.status}
      className={cx(cardClass(), "group block overflow-hidden transition-[transform,border-color,background-color,box-shadow] duration-(--dur-normal) ease-cf hover:-translate-y-[3px] hover:border-line-strong hover:bg-surface-hover", focusRing)}>
      <div className="relative aspect-[4/3] overflow-hidden bg-surface-sunken sm:aspect-[4/5]">
        {card.thumbnailUrl
          // eslint-disable-next-line @next/next/no-img-element -- imagem servida por rota com IDs (sem vídeo no grid)
          ? <img src={card.thumbnailUrl} alt="" loading="lazy" className="size-full object-cover transition-transform duration-(--dur-emph) ease-cf group-hover:scale-[1.03]" />
          : <div className="grid size-full place-items-center bg-[radial-gradient(circle_at_30%_20%,rgb(124_58_237/0.18),transparent_60%)] text-fg-subtle"><ImageOff className="size-6" aria-hidden /><span className="sr-only">Sem imagem</span></div>}
        <div className="absolute top-2.5 left-2.5 max-w-[calc(100%-1.25rem)]"><ProjectStatusBadge status={card.status} label={card.statusLabel} /></div>
        <span aria-hidden className="absolute right-2.5 bottom-2.5 inline-flex items-center gap-1 rounded-full bg-canvas/85 px-2.5 py-1 text-caption font-medium text-fg opacity-0 transition-opacity duration-(--dur-fast) group-hover:opacity-100 group-focus-visible:opacity-100">
          Abrir<ArrowUpRight className="size-3.5" />
        </span>
      </div>
      <div className="space-y-1 p-4">
        <p className="line-clamp-1 font-medium text-fg">{card.name}</p>
        {card.productName !== card.name ? <p className="line-clamp-1 text-caption text-fg-muted">{card.productName}</p> : null}
        <p className="truncate text-caption text-fg-subtle tabular">{[card.avatarName, card.durationLabel].filter(Boolean).join(" · ")}</p>
        <p className="flex items-center justify-between gap-2 text-caption text-fg-subtle tabular">
          <span className="truncate">{card.dateLabel}</span>
          {credits ? <span className="shrink-0 text-fg-muted" data-card-credits>{credits}</span> : null}
        </p>
      </div>
    </Link>
  );
}
