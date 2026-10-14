import type { PresetSummary } from "@/costs/preset-summary";
import { formatBrl } from "@/lib/money";

export function QualityPresetCard({ preset }: { preset: PresetSummary }) {
  return (
    <article className="rounded-xl border border-neutral-800 bg-neutral-900 p-5">
      <h2 className="text-lg font-semibold">{preset.label}</h2>
      <p className="mt-1 text-sm text-neutral-400">{preset.description}</p>
      <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
        <dt className="text-neutral-500">Provider/modelo</dt>
        <dd className="font-mono text-xs">{preset.videoProviderLabel}</dd>
        <dt className="text-neutral-500">Planejamento</dt>
        <dd className="font-mono text-xs">{preset.llmModelLabel}</dd>
        <dt className="text-neutral-500">Vídeo IA</dt>
        <dd>
          {preset.generatedVideoSeconds.min}–{preset.generatedVideoSeconds.max}s
        </dd>
        <dt className="text-neutral-500">Duração final</dt>
        <dd>
          {preset.finalVideoSeconds.min}–{preset.finalVideoSeconds.max}s
        </dd>
        <dt className="text-neutral-500">Custo estimado</dt>
        <dd className="font-semibold">
          {formatBrl(preset.estimatedCostBrl.min)} – {formatBrl(preset.estimatedCostBrl.max)}
        </dd>
      </dl>
      {preset.containsPlaceholderPrices && (
        <p className="mt-4 text-xs text-amber-400">
          Estimativa com preços provisórios — provider ainda não definido.
        </p>
      )}
    </article>
  );
}
