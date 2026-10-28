"use client";

import { useState } from "react";
import { normalizeTags } from "@/domain/avatar";

/** Tags LIVRES (criadas pelo usuário): Enter ou vírgula adiciona; × remove. */
export function TagInput({ id, label, value, onChange, placeholder = "+ tag" }: { id: string; label: string; value: string[]; onChange: (tags: string[]) => void; placeholder?: string }) {
  const [draft, setDraft] = useState("");
  const add = (raw: string) => {
    const next = normalizeTags([...value, ...raw.split(",")]);
    onChange(next);
    setDraft("");
  };
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-zinc-200 bg-white px-3 py-2" aria-label={label} role="group">
      {value.map((tag) => (
        <span key={tag} className="inline-flex items-center gap-1 rounded-full bg-zinc-100 py-1 pr-1.5 pl-3 text-sm text-zinc-700">
          {tag}
          <button type="button" aria-label={`Remover ${tag}`} className="grid size-5 place-items-center rounded-full text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700" onClick={() => onChange(value.filter((t) => t !== tag))}>×</button>
        </span>
      ))}
      <input id={id} className="min-w-24 flex-1 border-0 bg-transparent py-1 text-sm outline-none placeholder:text-zinc-400" placeholder={placeholder} value={draft}
        onChange={(e) => (e.target.value.endsWith(",") ? add(e.target.value) : setDraft(e.target.value))}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (draft.trim()) add(draft); } }}
        onBlur={() => draft.trim() && add(draft)} />
    </div>
  );
}
