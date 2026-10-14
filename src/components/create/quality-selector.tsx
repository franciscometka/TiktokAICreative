"use client";

import { formatBrlRange, formatSecondsRange } from "@/application/cost-presentation";
import type { PresetSummary } from "@/costs/preset-summary";
import { cx, ProvisionalBadge } from "../ui/primitives";

/** Cards dos presets. Todos os números vêm do sistema de custos (summarizePresets). */
export function QualitySelector({
  presets,
  value,
  onChange,
}: {
  presets: PresetSummary[];
  value: string;
  onChange: (quality: string) => void;
}) {
  return (
    <div role="radiogroup" aria-label="Qualidade e custo" className="grid gap-3 md:grid-cols-3">
      {presets.map((preset) => {
        const selected = preset.quality === value;
        return (
          <button
            key={preset.quality}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(preset.quality)}
            className={cx(
              "flex flex-col rounded-lg border bg-white p-4 text-left transition-shadow focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900",
              selected ? "border-zinc-900 shadow-[0_0_0_1px_var(--color-zinc-900)]" : "border-zinc-200 hover:border-zinc-300",
            )}
          >
            <span className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold tracking-wider text-zinc-900 uppercase">{preset.label}</span>
              <span
                className={cx(
                  "grid size-4 place-items-center rounded-full border",
                  selected ? "border-zinc-900 bg-zinc-900" : "border-zinc-300",
                )}
                aria-hidden
              >
                {selected && <span className="size-1.5 rounded-full bg-white" />}
              </span>
            </span>
            <span className="mt-1.5 text-sm text-zinc-600">{preset.description}</span>
            <span className="mt-4 block text-2xl font-semibold tracking-tight text-zinc-900 tabular">
              ≈ {formatBrlRange(preset.estimatedCostBrl)}
            </span>
            <span className="text-xs text-zinc-500">estimativa por criativo</span>
            <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-2 border-t border-zinc-100 pt-3 text-sm">
              <div>
                <dt className="text-xs text-zinc-500">Vídeo IA</dt>
                <dd className="font-medium tabular">{formatSecondsRange(preset.generatedVideoSeconds)}</dd>
              </div>
              <div>
                <dt className="text-xs text-zinc-500">Vídeo final</dt>
                <dd className="font-medium tabular">{formatSecondsRange(preset.finalVideoSeconds)}</dd>
              </div>
              <div className="col-span-2">
                <dt className="text-xs text-zinc-500">Planejamento</dt>
                <dd className="font-medium">
                  {preset.llmModelName} <span className="font-normal text-zinc-500">· esforço {preset.llmEffort}</span>
                </dd>
              </div>
            </dl>
            {preset.containsPlaceholderPrices && (
              <span className="mt-3">
                <ProvisionalBadge static />
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
