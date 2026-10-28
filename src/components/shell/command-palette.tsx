"use client";

import { FolderOpen, Home, LayoutGrid, Search, Settings, UserRound, Video, Zap, type LucideIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { groupItems, moveActive, paletteItems, resolveActive, type PaletteData, type PaletteItem } from "@/application/command-palette";
import { cx, Spark } from "../ds";
import { Kbd } from "./nav-parts";

/**
 * L8.8 — Command Palette (Ctrl+K / ⌘K). <dialog> nativo (top layer, foco preso; ao fechar, o foco
 * volta para quem abriu). Combobox + listbox com `aria-activedescendant`: o foco real fica no campo
 * e as setas percorrem só os itens. Enter abre; Esc fecha. Só navegação/criação — nada destrutivo
 * nem de aprovação de gasto.
 */

const ICONS: Record<Exclude<PaletteItem["icon"], "spark">, LucideIcon> = {
  avatar: UserRound, projects: LayoutGrid, credits: Zap, settings: Settings, project: Video, home: Home,
};

export function PaletteView({ query, onQuery, items, active, onActive, onPick, onKeyDown, listId, inputId }: {
  query: string; onQuery: (q: string) => void; items: PaletteItem[]; active: number; onActive: (i: number) => void;
  onPick: (item: PaletteItem) => void; onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void; listId: string; inputId: string;
}) {
  const groups = groupItems(items);
  const activeId = active >= 0 && items[active] ? `${listId}-${active}` : undefined;
  return (
    <div className="flex max-h-[min(70dvh,32rem)] flex-col" data-palette>
      <div className="flex items-center gap-3 border-b border-line px-4">
        <Search className="size-[18px] shrink-0 text-fg-subtle" aria-hidden />
        <input id={inputId} role="combobox" aria-expanded="true" aria-controls={listId} aria-activedescendant={activeId} aria-autocomplete="list" aria-label="O que você quer fazer?"
          autoComplete="off" spellCheck={false} value={query} onChange={(e) => onQuery(e.target.value)} onKeyDown={onKeyDown} placeholder="O que você quer fazer?" data-autofocus
          className="h-14 min-w-0 flex-1 bg-transparent text-body text-fg outline-none placeholder:text-fg-subtle" />
        <Kbd>Esc</Kbd>
      </div>
      <div id={listId} role="listbox" aria-label="Resultados" className="min-h-0 flex-1 overflow-y-auto p-2">
        {items.length === 0 ? (
          <p className="px-3 py-10 text-center text-sm text-fg-muted" role="status" data-palette-empty>Nada encontrado.</p>
        ) : groups.map((g) => (
          <div key={g.group} role="group" aria-label={g.group} className="mb-1">
            <p aria-hidden className="px-3 pt-2 pb-1 text-[11px] font-medium tracking-wide text-fg-subtle uppercase">{g.group}</p>
            {g.items.map(({ item, index }) => {
              const Icon = item.icon === "spark" ? null : ICONS[item.icon];
              const selected = index === active;
              return (
                <div key={item.id} id={`${listId}-${index}`} role="option" aria-selected={selected} onMouseMove={() => onActive(index)} onClick={() => onPick(item)} data-palette-item={item.id}
                  className={cx("flex h-11 cursor-pointer items-center gap-3 rounded-lg px-3 text-sm transition-colors duration-(--dur-fast)", selected ? "bg-primary-soft text-fg" : "text-fg-muted")}>
                  <span className={cx("grid size-7 shrink-0 place-items-center rounded-md ring-1 ring-inset", selected ? "bg-primary/20 text-primary-light ring-primary/30" : "bg-fg/[0.04] text-fg-subtle ring-line")}>
                    {Icon ? <Icon className="size-4" aria-hidden /> : <Spark inherit className="text-[13px]" />}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.hint ? <span className="shrink-0 text-caption text-fg-subtle">{item.hint}</span> : null}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div className="hidden items-center gap-4 border-t border-line px-4 py-2.5 text-caption text-fg-subtle sm:flex" aria-hidden>
        <span className="flex items-center gap-1.5"><Kbd>↑</Kbd><Kbd>↓</Kbd>navegar</span>
        <span className="flex items-center gap-1.5"><Kbd>Enter</Kbd>abrir</span>
        <span className="flex items-center gap-1.5"><FolderOpen className="size-3.5" />projetos e avatares recentes</span>
      </div>
    </div>
  );
}

export function CommandPalette({ open, onClose, data }: { open: boolean; onClose: () => void; data: PaletteData }) {
  const router = useRouter();
  const ref = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  // L8.8.1: seleção pelo ID do item; o índice efetivo (destaque E Enter) sai de resolveActive.
  const [activeId, setActiveId] = useState<string | null>(null);
  const listId = useId();
  const inputId = useId();
  const items = useMemo(() => paletteItems(query, data), [query, data]);
  const active = resolveActive(activeId, items);

  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      // Guarda quem abriu (botão, atalho a partir de um campo...) para devolver o foco ao fechar.
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
    }
    if (!open && dialog.open) {
      dialog.close();
      if (opener.current?.isConnected) opener.current.focus();
    }
  }, [open]);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const onCancel = (e: Event) => { e.preventDefault(); onClose(); };
    dialog.addEventListener("cancel", onCancel);
    return () => dialog.removeEventListener("cancel", onCancel);
  }, [onClose]);

  const close = () => { setQuery(""); setActiveId(null); onClose(); };
  const pick = (item: PaletteItem) => { close(); router.push(item.href); };
  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || ((e.key === "Home" || e.key === "End") && e.ctrlKey)) {
      e.preventDefault();
      const next = moveActive(active, items.length, e.key as "ArrowDown");
      setActiveId(next >= 0 ? items[next]!.id : null);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = items[active];
      if (item) pick(item);
    }
  }

  return (
    <dialog ref={ref} aria-label="Command Palette" onClick={(e) => { if (e.target === e.currentTarget) close(); }}
      className="cf-overlay m-auto mt-[12vh] w-[calc(100%-2rem)] max-w-xl rounded-2xl border border-line-strong bg-elevated p-0 text-fg shadow-pop open:animate-scale-in max-sm:mt-4">
      {open ? <PaletteView query={query} onQuery={(q) => { setQuery(q); setActiveId(null); }} items={items} active={active} onActive={(i) => setActiveId(items[i]?.id ?? null)} onPick={pick} onKeyDown={onKeyDown} listId={listId} inputId={inputId} /> : null}
    </dialog>
  );
}
