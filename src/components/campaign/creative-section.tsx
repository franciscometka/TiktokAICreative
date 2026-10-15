import { formatSeconds } from "@/application/cost-presentation";
import type { CreativeView, SceneView } from "@/application/campaign-view";
import type { VisualSource } from "@/domain/creative";
import { formatBrl } from "@/lib/money";
import { Badge, cx, Notice, Panel, type Tone } from "../ui/primitives";
import { jobStatusTone } from "./status";

const SOURCE_TONE: Record<VisualSource, Tone> = {
  generated_video: "blue",
  product_hero: "blue", product_demo: "blue", lifestyle: "blue", presenter: "blue", product_ugc: "blue",
  product_image: "green",
  text_card: "neutral",
  simple_background: "neutral",
  screenshot: "sky",
  existing_asset: "teal",
};

const SOURCE_BAR: Record<VisualSource, string> = {
  generated_video: "bg-blue-500",
  product_hero: "bg-blue-500", product_demo: "bg-blue-500", lifestyle: "bg-blue-500", presenter: "bg-blue-500", product_ugc: "bg-blue-500",
  product_image: "bg-emerald-500",
  text_card: "bg-zinc-400",
  simple_background: "bg-zinc-300",
  screenshot: "bg-sky-500",
  existing_asset: "bg-teal-500",
};

function range(scene: SceneView): string {
  const f = (n: number) => new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 }).format(n);
  return `${f(scene.startSeconds)}–${f(scene.endSeconds)}s`;
}

/** Barra proporcional das cenas: mostra de relance quanto do vídeo é IA. */
function TimelineBar({ scenes, total }: { scenes: SceneView[]; total: number }) {
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-zinc-100" aria-hidden>
      {scenes.map((s) => (
        <div
          key={s.id}
          className={cx("h-full border-r border-white last:border-r-0", SOURCE_BAR[s.visualSource])}
          style={{ width: `${((s.endSeconds - s.startSeconds) / total) * 100}%` }}
        />
      ))}
    </div>
  );
}

function SceneRow({ scene }: { scene: SceneView }) {
  return (
    <li className="grid gap-3 py-4 sm:grid-cols-[6.5rem_1fr] sm:gap-5">
      <div className="flex items-baseline gap-2 sm:block">
        <p className="text-xs font-semibold tracking-wider text-zinc-500 uppercase">Cena {String(scene.number).padStart(2, "0")}</p>
        <p className="text-sm font-medium text-zinc-900 tabular sm:mt-0.5">{range(scene)}</p>
      </div>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={SOURCE_TONE[scene.visualSource]} dot>
            {scene.visualSourceLabel}
            {scene.isGenerated && ` · ${formatSeconds(scene.generatedSeconds)}`}
          </Badge>
          {scene.motionLabel && <Badge>{scene.motionLabel}</Badge>}
          <span className="text-xs text-zinc-500">
            {scene.shotTypeLabel}
            {scene.transitionLabel && ` · entra com ${scene.transitionLabel}`}
          </span>
        </div>
        <dl className="mt-3 grid gap-3 text-sm md:grid-cols-2">
          <div className="min-w-0">
            <dt className="text-xs text-zinc-500">Narração</dt>
            <dd className="mt-0.5 text-zinc-800">{scene.narration ? `“${scene.narration}”` : <span className="text-zinc-400">Sem fala</span>}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs text-zinc-500">Texto na tela</dt>
            <dd className="mt-0.5 font-medium text-zinc-900">{scene.onScreenText || <span className="font-normal text-zinc-400">—</span>}</dd>
          </div>
          <div className="min-w-0 md:col-span-2">
            <dt className="text-xs text-zinc-500">Visual</dt>
            <dd className="mt-0.5 text-zinc-700">{scene.visualDescription}</dd>
          </div>
        </dl>
        {scene.isGenerated && scene.generationPrompt && (
          <details className="group mt-3 rounded-md border border-zinc-200 bg-zinc-50/60">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 text-xs font-medium text-zinc-600 select-none hover:text-zinc-900">
              <svg viewBox="0 0 16 16" className="size-3 transition-transform group-open:rotate-90" fill="none" aria-hidden>
                <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Ver prompt de geração
            </summary>
            <p className="border-t border-zinc-200 px-3 py-2.5 font-mono text-xs leading-relaxed break-words text-zinc-700">
              {scene.generationPrompt}
            </p>
          </details>
        )}
      </div>
    </li>
  );
}

export function CreativeSection({ creative }: { creative: CreativeView }) {
  const n = String(creative.number).padStart(2, "0");
  return (
    <section id={`criativo-${creative.number}`} className="scroll-mt-20">
      <Panel>
        <header className="border-b border-zinc-100 p-5 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-semibold tracking-wider text-zinc-500 uppercase">
              Criativo {n} · {creative.concept.formatLabel}
            </p>
            {creative.jobStatus && (
              <Badge tone={jobStatusTone(creative.jobStatus, creative.interrupted)} dot>
                {creative.jobStatusLabel}
              </Badge>
            )}
          </div>
          <h3 className="mt-1.5 text-lg font-semibold tracking-tight">{creative.concept.title}</h3>
          <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-3 text-sm">
            <div>
              <dt className="text-xs text-zinc-500">Vídeo final</dt>
              <dd className="text-base font-semibold tabular">{formatSeconds(creative.durationSeconds)}</dd>
            </div>
            <div>
              <dt className="text-xs text-zinc-500">Vídeo IA</dt>
              <dd className="text-base font-semibold text-blue-700 tabular">{formatSeconds(creative.generatedSeconds)}</dd>
            </div>
            <div>
              <dt className="text-xs text-zinc-500">Cenas</dt>
              <dd className="text-base font-semibold tabular">{creative.scenes.length}</dd>
            </div>
            {creative.estimate && (
              <div>
                <dt className="text-xs text-zinc-500">Geração estimada</dt>
                <dd className="text-base font-semibold tabular">
                  <a href={`#custo-${creative.number}`} className="underline decoration-zinc-300 underline-offset-4 hover:decoration-zinc-900">
                    {formatBrl(creative.estimate.futureTotalBrl)}
                  </a>
                </dd>
              </div>
            )}
          </dl>
        </header>

        <div className="space-y-5 p-5 sm:p-6">
          {creative.adjustment && (
            <Notice tone="blue" title={`Plano otimizado para caber no modo ${creative.adjustment.qualityLabel}.`}>
              <p>
                {creative.adjustment.suggestedBy} sugeriu{" "}
                <span className="font-semibold tabular">{formatSeconds(creative.adjustment.suggestedSeconds)} de vídeo IA</span>; ajustado para{" "}
                <span className="font-semibold tabular">{formatSeconds(creative.adjustment.adjustedSeconds)}</span>.
              </p>
              <details className="mt-1 text-xs">
                <summary className="cursor-pointer select-none">O que mudou</summary>
                <ul className="mt-1.5 list-disc space-y-0.5 pl-4">
                  {creative.adjustment.messages.map((m, i) => (
                    <li key={i}>{m}</li>
                  ))}
                </ul>
              </details>
            </Notice>
          )}
          {creative.warnings.length > 0 && (
            <Notice title="Observações do plano">
              <ul className="list-disc space-y-0.5 pl-4">
                {creative.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </Notice>
          )}

          <div className="grid gap-5 lg:grid-cols-[1fr_16rem]">
            <div className="min-w-0 space-y-4">
              <div>
                <h4 className="text-xs font-semibold tracking-wider text-zinc-500 uppercase">Hook</h4>
                <p className="mt-1 text-[17px] leading-snug font-semibold text-zinc-900">“{creative.hook}”</p>
              </div>
              <div>
                <h4 className="text-xs font-semibold tracking-wider text-zinc-500 uppercase">Roteiro</h4>
                <p className="mt-1 text-sm leading-relaxed text-zinc-700">{creative.script}</p>
              </div>
            </div>
            <div className="min-w-0 rounded-md bg-zinc-50 p-4">
              <h4 className="text-xs font-semibold tracking-wider text-zinc-500 uppercase">CTA</h4>
              <p className="mt-1 text-sm font-medium text-zinc-900">{creative.callToAction}</p>
            </div>
          </div>

          <div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-xs font-semibold tracking-wider text-zinc-500 uppercase">Cenas</h4>
              <p className="flex flex-wrap items-center gap-3 text-xs text-zinc-500">
                <span className="flex items-center gap-1.5">
                  <span className="size-2 rounded-sm bg-blue-500" aria-hidden /> Vídeo IA
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="size-2 rounded-sm bg-emerald-500" aria-hidden /> Imagem do produto
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="size-2 rounded-sm bg-zinc-400" aria-hidden /> Composição
                </span>
              </p>
            </div>
            <div className="mt-3">
              <TimelineBar scenes={creative.scenes} total={creative.durationSeconds} />
            </div>
            <ol className="mt-2 divide-y divide-zinc-100">
              {creative.scenes.map((scene) => (
                <SceneRow key={scene.id} scene={scene} />
              ))}
            </ol>
          </div>
        </div>
      </Panel>
    </section>
  );
}
