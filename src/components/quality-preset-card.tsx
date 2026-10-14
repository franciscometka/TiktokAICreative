import { formatBrlRange, formatSecondsRange } from "@/application/cost-presentation";
import type { PresetSummary } from "@/costs/preset-summary";
import { Panel, ProvisionalBadge } from "./ui/primitives";

export function QualityPresetCard({ preset }: { preset: PresetSummary }) {
  return (
    <Panel className="p-5">
      <p className="text-xs font-semibold tracking-wider text-zinc-900 uppercase">{preset.label}</p>
      <p className="mt-1.5 text-sm text-zinc-600">{preset.description}</p>
      <p className="mt-4 text-2xl font-semibold tracking-tight tabular">≈ {formatBrlRange(preset.estimatedCostBrl)}</p>
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
        <div className="col-span-2">
          <dt className="text-xs text-zinc-500">Vídeo (provider)</dt>
          <dd className="font-mono text-xs text-zinc-700">{preset.videoProviderLabel}</dd>
        </div>
      </dl>
      {preset.containsPlaceholderPrices && (
        <div className="mt-3">
          <ProvisionalBadge />
        </div>
      )}
    </Panel>
  );
}
