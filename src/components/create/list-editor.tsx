"use client";

import { useState } from "react";
import { inputClasses } from "../ui/field";
import { buttonClasses } from "../ui/primitives";

/** Lista editável de itens curtos (características, benefícios). Enter adiciona. */
export function ListEditor({
  id,
  items,
  onChange,
  placeholder,
  max,
  invalid,
}: {
  id: string;
  items: string[];
  onChange: (items: string[]) => void;
  placeholder: string;
  max: number;
  invalid?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const full = items.length >= max;

  const add = () => {
    const value = draft.trim();
    if (!value || full) return;
    onChange([...items, value]);
    setDraft("");
  };

  return (
    <div>
      {items.length > 0 && (
        <ul className="mb-2 space-y-1.5">
          {items.map((item, i) => (
            <li key={`${i}-${item}`} className="flex items-center gap-2">
              <input
                aria-label={`Item ${i + 1}`}
                className={inputClasses()}
                value={item}
                onChange={(e) => onChange(items.map((it, j) => (j === i ? e.target.value : it)))}
              />
              <button
                type="button"
                className={buttonClasses("ghost", "sm")}
                onClick={() => onChange(items.filter((_, j) => j !== i))}
                aria-label={`Remover item ${i + 1}`}
              >
                Remover
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <input
          id={id}
          className={inputClasses(invalid)}
          value={draft}
          placeholder={full ? `Limite de ${max} itens` : placeholder}
          disabled={full}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <button type="button" className={buttonClasses("secondary", "md")} onClick={add} disabled={!draft.trim() || full}>
          Adicionar
        </button>
      </div>
    </div>
  );
}
